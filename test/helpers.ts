import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'

export const PHONE = '13800138000'
export const EMAIL = 'john@example.com'
export const SECRET_KEY = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ABCDEFGHIJ'

export function userMessage(text: string, id = 'm1'): Message {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as Message
}

export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

export function chunkStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield* chunks
  })()
}
