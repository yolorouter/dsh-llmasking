import type { Context } from '@deepseek-ai/cordis'
// Type-only ambient pulls: both packages augment the cordis `Context`/
// `Events` interfaces (llm/stream, systemPrompt) our registrations use.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { Engine } from 'llmasking'
import { maskRequest } from './mask-request.js'
import { isMaskedRequest } from './reentry.js'
import { restoreStream } from './restore-stream.js'
import { MaskingStates } from './state.js'

export const name = 'llmasking'

export const inject = ['llm']

export interface Config {
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

export function apply(ctx: Context, config: Config): void {
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

    // Re-dispatch the masked copy through the full waterfall; our listener
    // sees the marker above and lets it reach the adapter. Restore real
    // values into every chunk the rest of dsh consumes.
    return restoreStream(ctx.llm.stream(outcome.request), session, (message) => {
      ctx.logger.warn(message)
    })
  })
}
