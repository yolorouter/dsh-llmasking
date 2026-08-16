# dsh-llmasking

**Transport-layer data masking for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): sensitive values never leave the process on their way to the model — while your session log, UI, and tool executions keep seeing real values, restored live in the stream.**

```
session log (real values)
        │ deriveMessages()
        ▼
┌─ dsh-llmasking (llm/stream) ─────────────────────────┐
│  mask request copy: 13800138000 → [PHONE_1]          │
│  re-dispatch masked copy through the waterfall       │
│  restore every response chunk on the way back,       │
│  including placeholders split across SSE boundaries  │
└──────────────────┬───────────────────────────────────┘
                   ▼
        provider / model sees only placeholders
```

The threat model is **logs keep truth, the wire carries masks**: your dsh session log, terminal UI, and every tool execution see real values; only what crosses the network to the LLM provider is masked. Session titles and compaction summaries are covered too — they ride the same `llm/stream` seam.

Powered by the [llmasking](https://www.npmjs.com/package/llmasking) engine: universal detectors (email, bank card with Luhn check, IP, URL, international phone, secret family: cloud keys / PEM / JWT / git tokens / high-entropy passwords), CN rules (mobile, ID card with ISO 7064 check, landline), US rules (SSN, phone), plus your own keywords. Same value → same placeholder within a session; **secrets are redacted one-way** (`[SECRET_1]` never maps back).

## Quick start

**1. Install dsh** (skip if you already run it — needs Node ≥ 22, dsh ≥ `0.1.0-rc.6`):

```sh
npm install -g @deepseek-ai/dsh
dsh --version
```

**2. Install the plugin into a profile.** Pick any profile name — dsh initializes it with `dsh-base` on first use:

```sh
dsh plugin --profile my add dsh-llmasking
```

**3. Boot it:**

```sh
dsh --profile my
```

**4. Configure a model.** In the Web UI: Settings → Models — set your Base URL and API key (dsh stores credentials under `$DSH_HOME`, never in the repo). Or edit `~/.dsh/settings.yaml`:

```yaml
llm-deepseek:
  baseURL: https://api.deepseek.com
```

…with your key in `$DSH_HOME/.credentials.yaml` or the `DEEPSEEK_API_KEY` environment variable.

**5. Verify the plugin is active** (two ways):

```sh
dsh --profile my --dump-config | grep -A1 "id: llmasking"
```

or in the Web UI: Settings → Plugins → search `llmasking` → status should be **active**.

**6. See it work** — run the [secret-echo test](#how-do-i-know-it-is-working) below. That's the whole setup.

### Installing from GitHub instead

Installs source rather than the npm build; pnpm ≥ 10 will ask you to allow the build script — only do this for sources you trust:

```sh
dsh plugin --profile my add github:yolorouter/dsh-llmasking
# then follow pnpm's hint: add "dsh-llmasking: true" under allowBuilds
# in the profile's pnpm-workspace.yaml and re-run
```

## Configuration

Defaults are deliberate; most users need none of this. Override per profile in `cordis.patch.yml` (row config replaces wholesale, no deep merge):

```yaml
- replace:
    - id: llmasking
      config:
        keywords: ["acme-corp-token"]
        regions: ["CN", "US"]
        maskSystem: true
        teachModel: true
```

| Option | Default | Meaning |
|---|---|---|
| `mode` | `enforce` | `enforce` masks the wire. `monitor` is a shadow mode — counts and logs what WOULD be masked but sends real values to the provider; useful for building trust before enforcing |
| `keywords` | `[]` | Extra literal keywords to mask (added to all built-in detectors) |
| `regions` | all | Geo rule packs to enable: `CN`, `US` (universal rules are always on) |
| `maskSystem` | `true` | Mask the system prompt slot too — project instructions (AGENTS.md etc.) can carry secrets |
| `teachModel` | `true` | Add a short system-prompt section telling the model what placeholders are and to reproduce them verbatim |

## How it works

- Intercepts every model call in the `llm/stream` waterfall (the seam dsh documents for exactly this: *"yield your own chunks to short-circuit"*). Requests are immutable there, so it builds a **frozen masked copy** — system prompt, every text/reasoning block (user input, assistant history, tool results), and tool-call arguments (parsed, masked per decoded string value, re-serialized so JSON-escaped values can't hide) — then re-dispatches it. A process-local marker stops the second pass from recursing.
- The response stream is wrapped: text/reasoning deltas flow through per-block restorers that **withhold and stitch placeholders split across chunk boundaries** (flushed at block close, so a withheld tail is never silently dropped), and each assembled `block-end` block is restored authoritatively. That last part is also the write-back path: when the model writes `[PHONE_1]` into a tool call, the assembled arguments are restored before the tool executes — the file/command operates on the real value.
- Placeholder mapping lives in memory, one mapping per dsh session, shared by main-loop, title, and compaction calls. No custom session events are written: dsh currently refuses to load logs containing event types unknown to the harness, and persistence isn't needed anyway — the log stores real values, so the next request re-masks deterministically.
- Sensitive-free requests take a zero-overhead passthrough (`next()`, original request, no stream wrapping).
- **Masking fails closed** (if a string exceeds the engine's input cap the request is refused rather than sent unmasked); **restore fails open** (on a restore error the masked text passes through with a warning — masking is the security boundary and it already happened).

## Observing it: the log line and the `/llmasking` command

Every masked turn writes one receipt line to the dsh log (counts and entity types only — never values):

```
llmasking: 3 value(s) masked on the wire this turn (PHONE, EMAIL, SECRET)
```

The `/llmasking` slash command (works in the TUI and the Web UI) is the receipt and the self-test:

- `/llmasking` — status: mode, detector config, this session's masking stats, totals since load
- `/llmasking verify` — runs a sentinel value through the real masking pipeline locally (zero network) and shows the before/after: `My phone number is 13800138000…` → `…[PHONE_1]…`. PASS means the pipeline is live
- `/llmasking status` — same as the bare command

## How do I know it is working?

The plugin is invisible by design — your logs, UI, and tool executions all show real values. Two ways to see the masking with your own eyes:

**The secret-echo test (30 seconds, no tools).** Send one message containing a phone number and a labeled API key, asking the model to repeat both back:

```
我的手机号是 13800138000，API key 是 OPENAI_API_KEY=sk-proj-xxxx，请原样复述这两项。
```

In the reply, the phone number appears as the real value (restored), while the key position shows `[SECRET_1]` — secrets are masked one-way and never restored. That `[SECRET_1]` is the proof the model never saw the real key: if it had, the restored echo would show it. For a control experiment, disable the plugin (set `disabled: true` on the `llmasking` row in your profile's `cordis.patch.yml`) and ask again — this time the model recites your real key.

**Wire inspection (for the unconvinced).** Point `llm-deepseek.baseURL` at any logging proxy and inspect what actually leaves the process: your real values never appear; `[PHONE_1]`-style placeholders do. What dsh logs locally is original data BY DESIGN ("logs keep truth, the wire carries masks") — so the trace view is never the place to look.

## What it does NOT do (honest boundaries)

- **Not a vault.** It is not an exec-time credential broker and never writes mappings to disk. If you need the model to *use* a credential without seeing it, that's a different product category.
- **Secrets never come back.** The secret family (API keys, PEM blocks, JWTs, git tokens, high-entropy passwords) is redacted one-way. When the model echoes `[SECRET_1]`, it stays `[SECRET_1]`.
- **Detectors are patterns, not oracles.** Novel formats, unusual spellings, or values split across separate JSON string fragments (e.g. a tool output chunked into array elements mid-value) can pass through. Masking narrows the leak surface dramatically; it does not promise zero leakage.
- **The provider still learns metadata** — that a conversation happened, its shape, and the placeholders themselves.
- **Chunk-log fragments of tool arguments keep placeholders.** Only the assembled block (what tools execute and what the durable message stores) is guaranteed restored; dsh's in-tree adapters always emit it, but a hypothetical delta-only adapter would leave tool arguments masked. Tool arguments that DO get masked are re-serialized, which may normalize JSON number formatting (`1e2` → `100`) and collapse duplicate keys.
- **Mapping is per-process.** After a restart or fork, placeholders re-number deterministically from the real-value log (the first masked phone is `[PHONE_1]` again), but cross-fork numbering is not inherited.

## Development

```sh
npm install        # also builds dist/ (prepare script)
npm test           # vitest: transform units + a waterfall simulation
npm run build
```

The test suite includes a zero-leak assertion: the fake provider-side adapter asserts it never received a real phone, email, or API key.

## License

MIT — same as the [llmasking](https://github.com/yolorouter/llmasking-ts) engine it builds on.
