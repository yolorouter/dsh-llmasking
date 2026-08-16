import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * Process-local identity of requests this plugin already masked.
 *
 * dsh re-enters the `llm/stream` waterfall when we re-dispatch our masked
 * copy via `ctx.llm.stream()` (plain `next()` always forwards the ORIGINAL
 * frozen arguments — it cannot substitute a different request). This WeakSet
 * is how our own listener recognizes that second pass and steps aside. It
 * mirrors dsh's own `markAgentLoopRequest` identity (a WeakSet, not a
 * property, so it survives freezing and JSON tricks and never leaks into
 * anything the adapter or other listeners can observe).
 *
 * A WeakSet alone cannot cross module instances: two runtime copies of this
 * plugin (dual install, ESM+CJS) each get their own set and would re-mask
 * each other's output. The non-enumerable flag below closes that hole — it
 * survives freezing (it is defined before the freeze), is invisible to
 * JSON.stringify and spreads, and any module copy can read it.
 */
const MASKED_REQUESTS = new WeakSet<GenerateOptions>()
const MASKED_FLAG = '__llmaskingMasked__'

/** Marks one exact request object as already-masked by this plugin. */
export function markMaskedRequest<T extends GenerateOptions>(request: T): T {
  MASKED_REQUESTS.add(request)
  try {
    Object.defineProperty(request, MASKED_FLAG, { value: true })
  } catch {
    // Already frozen by someone else — the WeakSet still covers the
    // single-instance case.
  }
  return request
}

/** Tests whether the exact request object was already masked by this plugin. */
export function isMaskedRequest(request: GenerateOptions): boolean {
  return (
    MASKED_REQUESTS.has(request) ||
    (request as unknown as Record<string, unknown>)[MASKED_FLAG] === true
  )
}
