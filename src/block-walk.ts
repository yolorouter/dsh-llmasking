import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { transformJsonStrings } from './json-walk.js'

export type TextTransform = (text: string) => string

/**
 * Shared content walker behind both directions of the seam. Masking
 * (Session.anonymize) and restoring (Session.restore) transform requests
 * and responses through the SAME shape: text/reasoning blocks pass their
 * text through the transform, tool-call arguments per decoded JSON string
 * value (raw-text fallback for malformed emits), tool-result content
 * recursed, image attachments and unknown future block kinds untouched.
 *
 * Returns a replacement, or undefined when the transform changed nothing —
 * callers keep the original object, so untouched history stays
 * reference-identical and serialized arguments byte-identical.
 */
export function transformBlock(block: ContentBlock, transform: TextTransform): ContentBlock | undefined {
  switch (block.type) {
    case 'text':
    case 'reasoning': {
      if (block.text === '') return undefined
      const text = transform(block.text)
      return text === block.text ? undefined : { ...block, text }
    }
    case 'tool-call': {
      if (block.arguments === '') return undefined
      const args = transformJsonText(block.arguments, transform)
      return args === block.arguments ? undefined : { ...block, arguments: args }
    }
    case 'tool-result': {
      const content = transformList(block.content, transform)
      return content === undefined ? undefined : { ...block, content }
    }
    default:
      // image attachments and any future block kinds: passthrough
      return undefined
  }
}

/** Returns replaced message content, or undefined when nothing changed. */
export function transformMessage(message: Message, transform: TextTransform): Message | undefined {
  const content = transformList(message.content, transform)
  return content === undefined ? undefined : { ...message, content }
}

function transformList(
  blocks: readonly ContentBlock[],
  transform: TextTransform,
): ContentBlock[] | undefined {
  let changed = false
  const out = blocks.map((block) => {
    const replacement = transformBlock(block, transform)
    if (replacement) {
      changed = true
      return replacement
    }
    return block
  })
  return changed ? out : undefined
}

function transformJsonText(raw: string, transform: TextTransform): string {
  return transformJsonStrings(raw, transform) ?? transform(raw)
}
