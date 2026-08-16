# dsh-llmasking

**给 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的传输层数据脱敏：敏感值在离开进程去往模型的路上被替换为占位符——而你的会话日志、界面和工具执行看到的始终是真值，并在流式响应中实时还原。**

```
会话日志（真值）
        │ deriveMessages()
        ▼
┌─ dsh-llmasking（llm/stream）─────────────────────────┐
│  请求副本脱敏：13800138000 → [PHONE_1]                │
│  脱敏副本重新进入瀑布分发                              │
│  响应流逐块还原，包括被 SSE 分块边界切开的占位符       │
└──────────────────┬───────────────────────────────────┘
                   ▼
        模型 / 服务商只见占位符
```

威胁模型是**日志存真值、上线走掩码**：dsh 的会话日志、终端 UI、每次工具执行都是真值；只有跨网络发往 LLM 服务商的内容是脱敏的。会话标题与压缩摘要同样覆盖——它们走同一条 `llm/stream` 通道。

底层是 [llmasking](https://www.npmjs.com/package/llmasking) 引擎：通用检测器（邮箱、银行卡 Luhn 校验、IP、URL、国际电话、密钥族：云密钥 / PEM / JWT / git token / 高熵口令）、中国规则（手机号、身份证 ISO 7064 校验、固话）、美国规则（SSN、电话），外加自定义关键词。同一会话内同值同占位符；**密钥族单向脱敏**（`[SECRET_1]` 永不还原）。

## 快速开始

**1. 安装 dsh**（已在用可跳过——需要 Node ≥ 22、dsh ≥ `0.1.0-rc.6`）：

```sh
npm install -g @deepseek-ai/dsh
dsh --version
```

**2. 把插件装进一个 profile。** 名字随意——首次使用时 dsh 会自动用 `dsh-base` 初始化该 profile：

```sh
dsh plugin --profile my add dsh-llmasking
```

**3. 启动：**

```sh
dsh --profile my
```

**4. 配置模型。** Web UI 里：设置 → 模型——填 Base URL 和 API key（dsh 把凭据存在 `$DSH_HOME`，不进仓库）。或编辑 `~/.dsh/settings.yaml`：

```yaml
llm-deepseek:
  baseURL: https://api.deepseek.com
```

key 放在 `$DSH_HOME/.credentials.yaml` 或环境变量 `DEEPSEEK_API_KEY`。

**5. 确认插件已激活**（两种方式）：

```sh
dsh --profile my --dump-config | grep -A1 "id: llmasking"
```

或在 Web UI：设置 → 插件 → 搜索 `llmasking` → 状态应为 **active**。

**6. 看它工作**——跑下面[怎么知道它在工作](#怎么知道它在工作)的密钥回显测试。装完即用，无需其他配置。

### 从 GitHub 安装

装的是源码而非 npm 构建产物；pnpm ≥ 10 会要求放行构建脚本——只对你信任的来源这样做：

```sh
dsh plugin --profile my add github:yolorouter/dsh-llmasking
# 然后按 pnpm 提示：在 profile 的 pnpm-workspace.yaml 里 allowBuilds 下
# 加 "dsh-llmasking: true"，重新执行
```

## 配置

默认值即推荐值，多数用户无需配置。在 profile 的 `cordis.patch.yml` 里整体覆盖（不深合并）：

```yaml
- replace:
    - id: llmasking
      config:
        keywords: ["公司令牌"]
        regions: ["CN", "US"]
        maskSystem: true
        teachModel: true
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `keywords` | `[]` | 额外掩码的字面关键词（叠加在内置检测器之上） |
| `regions` | 全部 | 启用的地域规则包：`CN`、`US`（通用规则恒开启） |
| `maskSystem` | `true` | 系统提示词也脱敏——项目指令（AGENTS.md 等）可能携带密钥 |
| `teachModel` | `true` | 注入一小节系统提示词，告诉模型占位符是什么、要求原样复述 |

## 工作原理

- 在 `llm/stream` 瀑布里拦截每一次模型调用（dsh 官方文档为这类用途留的缝：*"yield your own chunks to short-circuit"*）。请求在该处不可变，因此构造**冻结的脱敏副本**——系统提示词、所有 text/reasoning 块（用户输入、助手历史、工具结果）、工具调用参数（JSON 解析后按解码字符串逐个脱敏再重组，转义形态藏不住值）——然后重新分发。进程内标记防止第二遍递归。
- 响应流被包装：text/reasoning 增量流经按块的还原器，**跨 chunk 边界切开的占位符被扣留再拼合还原**（块关闭时 flush，扣留的尾部永不静默丢失）；组装完成的 `block-end` 块做权威还原。后者同时是写回路径：模型把 `[PHONE_1]` 写进工具调用时，参数在工具执行前已被还原——文件/命令操作的是真值。
- 占位符映射存内存，每个 dsh 会话一份，主循环、标题、压缩调用共享。不写自定义会话事件：dsh 当前会拒绝加载含未知事件类型的日志，而且也无需持久化——日志存真值，下次请求从真值确定性重新脱敏。
- 整个请求无敏感值时走零开销直通（`next()`，原请求，不包流）。
- **脱敏失败即关闭**（单个字符串超出引擎输入上限时拒绝整个请求，绝不放行未脱敏内容）；**还原失败即放行**（还原出错时带告警透传掩码文本——脱敏才是安全边界，且已经发生）。

## 怎么知道它在工作？

插件做好了的标志就是无声无息——日志、界面、工具执行看到的都是真值（这正是设计目标）。两个亲眼看到脱敏的方法：

**密钥回显测试（30 秒，无需工具）。** 发一条同时含手机号和带标签 API key 的消息，让模型复述：

```
我的手机号是 13800138000，API key 是 OPENAI_API_KEY=sk-proj-xxxx，请原样复述这两项。
```

回复里手机号位置是真值（被还原了），而密钥位置显示 `[SECRET_1]`——密钥单向脱敏、永不还原。那个 `[SECRET_1]` 就是模型从未见过真密钥的证据：它若见过，还原后的复述该显示真值。对照实验：在 profile 的 `cordis.patch.yml` 里给 `llmasking` 行设 `disabled: true` 关掉插件再问一次——这次模型能背出你的真密钥。

**抓包检验（给不信的人）。** 把 `llm-deepseek.baseURL` 指向任意记日志的代理，看真正离开进程的东西：真值零出现、`[PHONE_1]` 式占位符在场。dsh 本地日志存的是原始数据，这是设计（"日志存真值、上线走掩码"）——所以轨迹视图永远不是看脱敏的地方。

## 它不防什么（诚实边界）

- **不是保险库。** 不做执行时代填凭据，映射永不落盘。如果你需要模型*使用*某个凭据但不看见它，那是另一个品类。
- **密钥不会回来。** 密钥族（API key、PEM、JWT、git token、高熵口令）单向脱敏。模型复述 `[SECRET_1]`，它就保持 `[SECRET_1]`。
- **检测器是模式匹配，不是神谕。** 新格式、罕见写法、被拆散在多个 JSON 字符串片段里的值（如工具输出把一个值从中间切成两个数组元素）可能漏网。脱敏大幅收窄泄漏面，但不承诺零泄漏。
- **服务商仍获得元数据**——发生了对话、对话的形状、以及占位符本身。
- **chunk 日志里的工具参数片段保留占位符。** 只有组装块（工具执行与持久消息使用的）保证还原；dsh 内置适配器都会发它，但假想的纯增量适配器会让工具参数保持掩码。被脱敏的工具参数会重新序列化，可能规范化 JSON 数字写法（`1e2` → `100`）并折叠重复键。
- **映射随进程存续。** 重启或 fork 后，占位符从真值日志确定性重新编号（第一个手机号仍是 `[PHONE_1]`），但跨 fork 的编号不继承。

## 开发

```sh
npm install        # 同时构建 dist/（prepare 脚本）
npm test           # vitest：转换单测 + 瀑布仿真
npm run build
```

测试套件含零泄漏断言：假想的 provider 侧适配器断言自己从未收到真实手机号、邮箱或 API key。

## 许可

MIT——与它构建于其上的 [llmasking](https://github.com/yolorouter/llmasking-ts) 引擎一致。
