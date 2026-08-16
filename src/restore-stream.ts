import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from 'llmasking'
import { StreamRestorer } from 'llmasking'
import { transformBlock } from './block-walk.js'

interface LiveRestorer {
  restorer: StreamRestorer
  kind: 'text-delta' | 'reasoning-delta'
}

/**
 * Wraps a model stream, restoring real values into every chunk the rest of
 * dsh consumes. The session log, the UI, and tool execution then see REAL
 * values (the threat model this plugin sells: logs store truth, only the
 * wire sees placeholders).
 *
 * Two layers, on purpose:
 *
 * - `text-delta` / `reasoning-delta` stream through per-block-index
 *   StreamRestorers, so a placeholder split across chunk boundaries is
 *   withheld and restored live — the browser/UI never flickers placeholders.
 *   When a block closes, its restorer is FLUSHED and a final delta carries
 *   any withheld tail (flushing is what keeps a trailing fragment from
 *   being silently dropped); delta-only adapters get the same sweep when
 *   the stream ends. Restorers are discarded at block-end, so an adapter
 *   reusing a block index starts a fresh restorer, never a stale tail.
 * - `block-end` is the AUTHORITATIVE restore: dsh's BlockAssembler prefers
 *   the assembled block over accumulated deltas, the durable assistant
 *   message is built from it, and tool arguments execute from it. Restoring
 *   here is what makes model-written `[PHONE_1]` become the real value in
 *   the file/command the tool actually runs (the write-back path — dsh's
 *   `tools/pre-execute` is decision-only and cannot rewrite arguments).
 *
 * `tool-call-delta` fragments pass through still-masked (only the chunk log
 * keeps them; assembly takes the restored block-end). `usage`, `finish`,
 * `block-start` pass through untouched — and nothing is ever emitted after
 * a finish marker.
 *
 * Restore failures degrade OPEN (yield the masked text, warn): masking is
 * the security boundary and it already happened; failing the whole response
 * over a restore hiccup would trade availability for nothing.
 */
export function restoreStream(
  source: AsyncIterable<StreamChunk>,
  session: Session,
  warn?: (message: string) => void,
): AsyncIterable<StreamChunk> {
  const live = new Map<number, LiveRestorer>()
  const describe = (err: unknown): string => String(err instanceof Error ? err.message : err)
  const safeRestore = (text: string): string => {
    try {
      return session.restore(text).text
    } catch (err) {
      warn?.(`llmasking: restore failed (${describe(err)}); passing text through masked`)
      return text
    }
  }
  /** Closes one block's restorer, emitting its withheld tail as a delta. */
  function* flushLive(index: number, entry: LiveRestorer): Generator<StreamChunk> {
    live.delete(index)
    try {
      const { text } = entry.restorer.flush()
      if (text !== '') yield { type: entry.kind, index, text }
    } catch (err) {
      warn?.(`llmasking: stream flush failed (${describe(err)}); dropping the withheld tail`)
    }
  }

  return (async function* (): AsyncIterable<StreamChunk> {
    let finished = false
    for await (const chunk of source) {
      switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta': {
          let entry = live.get(chunk.index)
          if (!entry) {
            entry = { restorer: session.streamRestorer(), kind: chunk.type }
            live.set(chunk.index, entry)
          }
          try {
            const { text } = entry.restorer.write(chunk.text)
            yield { ...chunk, text }
          } catch (err) {
            warn?.(`llmasking: stream restore failed (${describe(err)}); passing chunk through masked`)
            yield chunk
          }
          break
        }
        case 'block-end': {
          const entry = live.get(chunk.index)
          if (entry) yield* flushLive(chunk.index, entry)
          yield { ...chunk, block: transformBlock(chunk.block, safeRestore) ?? chunk.block }
          break
        }
        case 'finish':
          finished = true
          yield chunk
          break
        default:
          yield chunk
      }
    }
    // Delta-only adapters never close their blocks; flush what they left
    // withheld. Skipped after finish — nothing may follow the marker.
    if (!finished) {
      for (const [index, entry] of [...live]) yield* flushLive(index, entry)
    }
  })()
}
