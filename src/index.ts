import type { Context } from '@deepseek-ai/cordis'
// Type-only ambient pulls: these packages augment the cordis `Context`/
// `Events` interfaces (llm/stream, systemPrompt, commands) our registrations use.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { Engine } from 'llmasking'
import { handleLlmaskingCommand } from './command.js'
import { maskRequest } from './mask-request.js'
import { isMaskedRequest } from './reentry.js'
import { restoreStream } from './restore-stream.js'
import { MaskingStates } from './state.js'

export const name = 'llmasking'

export const inject = ['llm']

export interface Config {
  /**
   * 'enforce' (default) masks the wire. 'monitor' is the shadow mode: it
   * counts and logs what WOULD be masked but sends real values to the
   * provider — for building trust before enforcing. (Typed string because
   * the schema is string-shaped; apply() validates and fails loud at load.)
   */
  mode: string
  /** Extra literal keywords to mask (added to the built-in detectors). */
  keywords: string[]
  /** Geo rule packs to enable ('CN', 'US'); default: all. */
  regions: string[]
  /** Mask the system prompt slot too (AGENTS.md content can carry secrets). */
  maskSystem: boolean
  /** Teach the model what the placeholders mean via a system prompt section. */
  teachModel: boolean
}

export const Config: z<Config> = z.object({
  mode: z.string().default('enforce'),
  keywords: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
  maskSystem: z.boolean().default(true),
  teachModel: z.boolean().default(true),
})

const TEACH_SECTION = [
  'Sensitive values in this conversation appear as placeholders such as [PHONE_1] or [EMAIL_2].',
  'Each placeholder stands for a real value that is deliberately not shown to you.',
  'Reproduce placeholders verbatim when referring to the original value — in prose, in files you write, and in tool arguments. Never invent, guess, complete, or try to decode them.',
].join(' ')

const VERSION = '0.1.1'

const SENTINEL_INPUT = 'My phone number is 13800138000, email john@example.com.'

export function apply(ctx: Context, config: Config): void {
  // Misconfiguration fails loud at load, per dsh convention.
  if (config.mode !== 'enforce' && config.mode !== 'monitor') {
    throw new Error(`llmasking: invalid mode ${JSON.stringify(config.mode)} (use "enforce" or "monitor")`)
  }
  const engine = new Engine({
    ...(config.keywords.length > 0 ? { keywords: config.keywords } : {}),
    ...(config.regions.length > 0 ? { regions: config.regions } : {}),
  })
  const states = new MaskingStates(engine)
  ctx.effect(() => () => states.dispose())

  if (config.teachModel) {
    // Optional dependency: the section is contributed only when a
    // system-prompt service is present (it rides ctx.inject, so the
    // registration appears and disappears with the service).
    ctx.inject(['systemPrompt'], (ctx) => {
      ctx.systemPrompt.section({
        name: 'llmasking',
        order: 150, // tool-guidance band; see dsh system-prompt conventions
        text: TEACH_SECTION,
      })
    })
  }

  // The `/llmasking` receipt command — status, per-session stats, self-verify.
  // Optional service, same pattern as the system prompt section.
  ctx.inject(['commands'], (ctx) => {
    ctx.commands.register({
      name: 'llmasking',
      description: 'llmasking status, masking stats, and self-verify',
      handler: (invocation) =>
        handleLlmaskingCommand(invocation.rawInput, invocation.agent?.session?.id, {
          version: VERSION,
          mode: config.mode as 'enforce' | 'monitor',
          regions: config.regions,
          keywords: config.keywords,
          statsFor: (sessionId) => states.statsFor(sessionId),
          totals: () => states.totalsView,
          sessionsTracked: () => states.sessionsTracked,
          verify: () => {
            const demo = engine.newSession()
            const before = SENTINEL_INPUT
            const { masked } = demo.anonymize(before)
            return { before, after: masked, passed: masked !== before && masked.includes('[PHONE_1]') && masked.includes('[EMAIL_1]') }
          },
        }),
    })
  })

  ctx.on('llm/stream', (options, next) => {
    // Our own re-dispatch of the masked copy: step aside.
    if (isMaskedRequest(options)) return next()

    // Session-scoped mapping for loop calls; a fresh ephemeral Session for
    // sessionId-less one-shots so unrelated hand-built calls never share
    // placeholder numbering.
    const session =
      options.sessionId === undefined ? engine.newSession() : states.sessionFor(options.sessionId)
    let outcome
    try {
      outcome = maskRequest(options, session, { maskSystem: config.maskSystem })
    } catch (err) {
      // Masking is the confidentiality boundary — fail closed.
      return (async function* (): AsyncIterable<never> {
        throw new Error(`llmasking: refusing to send unmasked request (${String(err instanceof Error ? err.message : err)})`)
      })()
    }
    // Nothing sensitive in the whole request: zero-overhead passthrough.
    if (!outcome.maskedAnything) return next()

    // Observability receipt: counts and entity types only, never values.
    states.record(options.sessionId, outcome.maskedEntities)
    const types = [...new Set(outcome.maskedEntities)].join(', ')
    if (config.mode === 'monitor') {
      ctx.logger.info(
        `llmasking [monitor]: would mask ${outcome.maskedEntities.length} value(s) this turn (${types}) — NOT enforcing, real values are on the wire`,
      )
      return next()
    }
    ctx.logger.info(`llmasking: ${outcome.maskedEntities.length} value(s) masked on the wire this turn (${types})`)

    // Re-dispatch the masked copy through the full waterfall; our listener
    // sees the marker above and lets it reach the adapter. Restore real
    // values into every chunk the rest of dsh consumes.
    return restoreStream(ctx.llm.stream(outcome.request), session, (message) => {
      ctx.logger.warn(message)
    })
  })
}
