import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session } from 'llmasking'
import { transformMessage } from './block-walk.js'
import { markMaskedRequest } from './reentry.js'

export interface MaskRequestOptions {
  /** Also mask the `system` prompt slot (default true). */
  maskSystem: boolean
}

export interface MaskOutcome {
  /** The request to dispatch — the ORIGINAL object when nothing was masked. */
  request: GenerateOptions
  /** Whether any value was masked (gates the re-dispatch and stream wrapping). */
  maskedAnything: boolean
}

/**
 * Builds a masked, frozen copy of an outbound request.
 *
 * LOOP-built requests arrive deep-frozen ("listeners read it, never rewrite
 * it"), and the agent-loop invariant compares `messages` against the session
 * log — so masking can never mutate in place. Everything the model reads as
 * free text is masked (see block-walk.ts for the per-block shape): `system`,
 * every `text`/`reasoning` block in `messages`, tool-result nested content,
 * and tool-call `arguments`. Tool SCHEMAS are configuration, not user data,
 * and the invariant pins them byte-for-byte — they pass through untouched.
 *
 * When nothing matched, the ORIGINAL request is returned unchanged so the
 * caller can take the zero-overhead `next()` path; anything the transform
 * did not alter keeps its original object reference.
 *
 * Masking is the confidentiality boundary, so it fails CLOSED: an llmasking
 * error (e.g. a single string over the input cap) propagates and aborts the
 * request rather than letting real values through unmasked.
 */
export function maskRequest(
  options: GenerateOptions,
  session: Session,
  opts: MaskRequestOptions,
): MaskOutcome {
  const transform = (text: string): string => session.anonymize(text).masked
  let changed = false

  let system = options.system
  if (opts.maskSystem && system !== undefined && system !== '') {
    const masked = transform(system)
    if (masked !== system) {
      system = masked
      changed = true
    }
  }

  const messages = options.messages.map((message) => {
    const masked = transformMessage(message, transform)
    if (masked) {
      changed = true
      return masked
    }
    return message
  })

  if (!changed) return { request: options, maskedAnything: false }

  const request: GenerateOptions = {
    ...options,
    ...(system !== options.system ? { system } : {}),
    messages,
  }
  return { request: markMaskedRequest(deepFreeze(request)), maskedAnything: true }
}

/**
 * Recursive Object.freeze, skipping AbortSignals (they are platform objects
 * that must keep functioning; dsh's own deepFreeze — not exported — makes
 * the same exception). The masked copy enters the waterfall frozen, exactly
 * like the requests it imitates, so downstream listeners get the same
 * read-only contract.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    if (!(value instanceof AbortSignal)) {
      Object.freeze(value)
      for (const key of Object.keys(value as Record<string, unknown>)) {
        deepFreeze((value as Record<string, unknown>)[key])
      }
    }
  }
  return value
}
