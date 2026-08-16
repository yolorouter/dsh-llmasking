import { describe, expect, it } from 'vitest'
import { Engine } from 'llmasking'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { transformJsonStrings } from '../src/json-walk.js'
import { isMaskedRequest, markMaskedRequest } from '../src/reentry.js'
import { maskRequest } from '../src/mask-request.js'
import { restoreStream } from '../src/restore-stream.js'
import { MaskingStates } from '../src/state.js'
import { chunkStream, collect, EMAIL, PHONE, SECRET_KEY, userMessage } from './helpers.js'

const engine = new Engine()

function toolCallMessage(args: string): Message {
  return {
    id: 'm2',
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: args }],
    source: { kind: 'model' },
  } as unknown as Message
}

function toolResultMessage(content: ContentBlock[]): Message {
  return {
    id: 'm3',
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'c1', content }],
    source: { kind: 'tool' },
  } as unknown as Message
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'fake',
    model: 'fake-model',
    messages: [userMessage(`call ${PHONE}`)],
    ...overrides,
  }
}

describe('transformJsonStrings', () => {
  it('transforms every decoded string value, preserving structure and key order', () => {
    const out = transformJsonStrings('{"b":"x13800138000x","a":[1,{"c":"no pii"}],"n":42}', (s) =>
      s.replace(PHONE, '[PHONE_1]'),
    )
    expect(out).toBe('{"b":"x[PHONE_1]x","a":[1,{"c":"no pii"}],"n":42}')
  })

  it('sees DECODED strings — a value containing a JSON-escaped quote is transformed whole', () => {
    const out = transformJsonStrings('{"note":"say \\"quoted\\" now"}', (s) => (s === 'say "quoted" now' ? 'REPLACED' : s))
    expect(out).toBe('{"note":"REPLACED"}')
  })

  it('returns the ORIGINAL bytes when nothing changed (number lexemes and key order never normalize)', () => {
    const raw = '{"a":1e2,"b":"plain","c":[true,null]}'
    expect(transformJsonStrings(raw, (s) => s)).toBe(raw)
  })

  it('returns undefined for non-JSON input', () => {
    expect(transformJsonStrings('not json', (s) => s)).toBeUndefined()
  })
})

describe('reentry marker', () => {
  it('marks and recognizes the exact object only', () => {
    const a = request()
    const b = request()
    expect(isMaskedRequest(a)).toBe(false)
    markMaskedRequest(a)
    expect(isMaskedRequest(a)).toBe(true)
    expect(isMaskedRequest(b)).toBe(false)
  })

  it('crosses module instances (dual install / ESM+CJS) via a non-enumerable flag', async () => {
    // Non-literal specifier: tsc must not resolve it — only vitest's runner
    // sees the query and loads a second module instance.
    const spec = '../src/reentry.js?instance=2'
    const copy = (await import(spec)) as typeof import('../src/reentry.js')
    const a = request()
    markMaskedRequest(a)
    expect(copy.isMaskedRequest(a)).toBe(true) // property, not the other WeakSet
    const b = request()
    copy.markMaskedRequest(b)
    expect(isMaskedRequest(b)).toBe(true)

    // The flag is invisible to serialization — the wire never sees it.
    expect(JSON.stringify(a)).not.toContain('__llmasking')
  })
})

describe('MaskingStates', () => {
  it('returns one Session per dsh session and clears on dispose', () => {
    const states = new MaskingStates(engine)
    const s1a = states.sessionFor('sess-1')
    const s1b = states.sessionFor('sess-1')
    const s2 = states.sessionFor('sess-2')
    expect(s1a).toBe(s1b)
    expect(s1a).not.toBe(s2)
    states.dispose()
    expect(states.sessionFor('sess-1')).not.toBe(s1a)
  })
})

describe('maskRequest', () => {
  it('masks text and system, returns a frozen copy, leaves the original untouched', () => {
    const session = engine.newSession()
    const original = request({ system: `reply to ${EMAIL}` })
    const outcome = maskRequest(original, session, { maskSystem: true })
    expect(outcome.maskedAnything).toBe(true)
    expect(outcome.request).not.toBe(original)
    expect(Object.isFrozen(outcome.request)).toBe(true)
    expect(isMaskedRequest(outcome.request)).toBe(true)
    // The original keeps real values and stays unmarked (next() would
    // forward it — our re-dispatch never sends it anywhere).
    expect(original.system).toBe(`reply to ${EMAIL}`)
    expect(original.messages[0]?.content[0]).toMatchObject({ type: 'text', text: `call ${PHONE}` })
    expect(outcome.request.system).toBe('reply to [EMAIL_1]')
    expect(outcome.request.messages[0]?.content[0]).toMatchObject({ type: 'text', text: 'call [PHONE_1]' })
    // Non-text request fields pass through verbatim — including tool
    // schemas by reference.
    const tools = [{ name: 'read', description: 'd', parameters: {} }]
    const withTools = request({ tools })
    const maskedTools = maskRequest(withTools, engine.newSession(), { maskSystem: true })
    expect(maskedTools.request.tools).toBe(tools)
  })

  it('masks tool-call arguments per decoded JSON string value, byte-identical when nothing matched', () => {
    const session = engine.newSession()
    const clean = request({ messages: [toolCallMessage('{"path":"a.txt","n":1e2}')] })
    expect(maskRequest(clean, session, { maskSystem: true }).maskedAnything).toBe(false)

    const original = request({
      messages: [toolCallMessage(`{"path":"a.txt","content":"reach me at ${PHONE}"}`)],
    })
    const outcome = maskRequest(original, session, { maskSystem: true })
    const block = outcome.request.messages[0]?.content[0] as Extract<ContentBlock, { type: 'tool-call' }>
    expect(JSON.parse(block.arguments)).toEqual({ path: 'a.txt', content: 'reach me at [PHONE_1]' })
  })

  it('masks a JSON-escaped value the serialized form would have hidden', () => {
    const kwEngine = new Engine({ keywords: ['AB"CD'] })
    const session = kwEngine.newSession()
    const original = request({ messages: [toolCallMessage('{"cmd":"echo AB\\"CD"}')] })
    const outcome = maskRequest(original, session, { maskSystem: true })
    const block = outcome.request.messages[0]?.content[0] as Extract<ContentBlock, { type: 'tool-call' }>
    expect(JSON.parse(block.arguments)).toEqual({ cmd: 'echo [KEYWORD_1]' })
  })

  it('masks tool-result content nested inside the result block', () => {
    const session = engine.newSession()
    const original = request({ messages: [toolResultMessage([{ type: 'text', text: `found ${PHONE}` }])] })
    const outcome = maskRequest(original, session, { maskSystem: true })
    const outer = outcome.request.messages[0]?.content[0] as Extract<ContentBlock, { type: 'tool-result' }>
    expect(outer.content[0]).toMatchObject({ type: 'text', text: 'found [PHONE_1]' })
  })

  it('passes image and unknown blocks through', () => {
    const session = engine.newSession()
    const image = { type: 'image', attachment: { id: 'att-1' } } as unknown as ContentBlock
    const original = request({ messages: [{ ...userMessage(''), content: [image] }] })
    const outcome = maskRequest(original, session, { maskSystem: true })
    expect(outcome.maskedAnything).toBe(false)
    expect(outcome.request).toBe(original)
  })

  it('returns the ORIGINAL object (identity) when nothing matched', () => {
    const session = engine.newSession()
    const original = request({ messages: [userMessage('nothing sensitive here')], system: 'plain system' })
    const outcome = maskRequest(original, session, { maskSystem: true })
    expect(outcome.maskedAnything).toBe(false)
    expect(outcome.request).toBe(original)
    expect(isMaskedRequest(original)).toBe(false)
  })

  it('keeps the system slot when maskSystem is false', () => {
    const session = engine.newSession()
    const original = request({ system: `reply to ${EMAIL}`, messages: [userMessage('hi')] })
    const outcome = maskRequest(original, session, { maskSystem: false })
    expect(outcome.maskedAnything).toBe(false)
    expect(outcome.request.system).toBe(`reply to ${EMAIL}`)
  })

  it('fails closed: a masking error propagates', () => {
    const tiny = new Engine({ maxInputBytes: 4 })
    const session = tiny.newSession()
    expect(() => maskRequest(request({ messages: [userMessage('this string is far over the cap')] }), session, { maskSystem: true })).toThrow()
  })
})

describe('restoreStream', () => {
  it('restores text deltas across a chunk-split placeholder and leaves assembly-consistent block-end', async () => {
    const session = engine.newSession()
    session.anonymize(`call ${PHONE}`)
    const chunks = await collect(
      restoreStream(
        chunkStream([
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: 'calling ' },
          { type: 'text-delta', index: 0, text: '[PH' },
          { type: 'text-delta', index: 0, text: 'ONE_1] now' },
          { type: 'block-end', index: 0, block: { type: 'text', text: 'calling [PHONE_1] now' } },
          { type: 'finish', reason: 'stop' as never },
        ]),
        session,
      ),
    )
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text)
    expect(deltas.join('')).toBe('calling 13800138000 now')
    const end = chunks.find((c) => c.type === 'block-end') as { block: ContentBlock }
    expect(end.block).toMatchObject({ type: 'text', text: 'calling 13800138000 now' })
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: 'stop' })
  })

  it('flushes a withheld tail as a final delta at block-end (no silent data loss)', async () => {
    const session = engine.newSession()
    session.anonymize(`call ${PHONE}`)
    const chunks = await collect(
      restoreStream(
        chunkStream([
          { type: 'text-delta', index: 0, text: 'calling ' },
          { type: 'text-delta', index: 0, text: '[PHONE' }, // withheld, never completed by a delta
          { type: 'block-end', index: 0, block: { type: 'text', text: 'calling [PHONE_1] now' } },
        ]),
        session,
      ),
    )
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text)
    expect(deltas.join('')).toBe('calling [PHONE') // tail survives, literally
    const end = chunks.find((c) => c.type === 'block-end') as { block: ContentBlock }
    expect(end.block).toMatchObject({ type: 'text', text: 'calling 13800138000 now' }) // authoritative
  })

  it('flushes withheld tails when a delta-only adapter ends without block-end', async () => {
    const session = engine.newSession()
    session.anonymize(`call ${PHONE}`)
    const chunks = await collect(
      restoreStream(chunkStream([{ type: 'text-delta', index: 0, text: 'call [PHON' }]), session),
    )
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')).toBe('call [PHON')
  })

  it('emits nothing after the finish marker (no post-finish sweep)', async () => {
    const session = engine.newSession()
    session.anonymize(`call ${PHONE}`)
    const chunks = await collect(
      restoreStream(
        chunkStream([
          { type: 'text-delta', index: 0, text: 'call [PHON' },
          { type: 'finish', reason: 'stop' as never },
        ]),
        session,
      ),
    )
    expect(chunks[chunks.length - 1]?.type).toBe('finish')
  })

  it('starts a fresh restorer when a block index is reused after block-end', async () => {
    const session = engine.newSession()
    session.anonymize(`call ${PHONE}`)
    const chunks = await collect(
      restoreStream(
        chunkStream([
          { type: 'text-delta', index: 0, text: 'use [PHONE_1]' },
          { type: 'block-end', index: 0, block: { type: 'text', text: 'use [PHONE_1]' } },
          { type: 'text-delta', index: 0, text: ' then plain' },
        ]),
        session,
      ),
    )
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text)
    expect(deltas.join('')).toBe(`use ${PHONE} then plain`)
  })

  it('restores reasoning deltas through their own per-index restorer', async () => {
    const session = engine.newSession()
    session.anonymize(`call ${PHONE}`)
    const chunks = await collect(
      restoreStream(
        chunkStream([
          { type: 'reasoning-delta', index: 1, text: 'think about [PH' },
          { type: 'reasoning-delta', index: 1, text: 'ONE_1]' },
        ]),
        session,
      ),
    )
    expect(chunks.map((c) => (c as { text: string }).text).join('')).toBe(`think about ${PHONE}`)
  })

  it('restores tool-call arguments at block-end, re-escaping JSON-special values', async () => {
    const kwEngine = new Engine({ keywords: ['AB"CD'] })
    const session = kwEngine.newSession()
    session.anonymize('echo AB"CD') // seeds [KEYWORD_1] -> AB"CD
    const rawArgs = '{"cmd":"echo [KEYWORD_1]"}'
    const chunks = await collect(
      restoreStream(
        chunkStream([
          { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: rawArgs } },
        ]),
        session,
      ),
    )
    const end = chunks[0] as { block: ContentBlock }
    // The restored quote must come back escaped — valid JSON out.
    expect((end.block as { arguments: string }).arguments).toBe('{"cmd":"echo AB\\"CD"}')
    expect(JSON.parse((end.block as { arguments: string }).arguments)).toEqual({ cmd: 'echo AB"CD' })
  })

  it('restores unmatched placeholders as-is (secrets are never reversible)', async () => {
    const session = engine.newSession()
    session.anonymize(`OPENAI_API_KEY=${SECRET_KEY}`)
    const chunks = await collect(
      restoreStream(chunkStream([{ type: 'text-delta', index: 0, text: 'key is [SECRET_1]' }]), session),
    )
    expect((chunks[0] as { text: string }).text).toBe('key is [SECRET_1]')
  })

  it('passes block-start, tool-call-delta, and usage chunks through untouched (identity)', async () => {
    const session = engine.newSession()
    const passthrough = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'tool-call-delta', index: 1, id: 'c1' as never, name: 'bash', argumentsDelta: '{"x":"[PHONE_1]"}' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 5 } },
    ] as const
    const chunks = await collect(restoreStream(chunkStream([...passthrough]), session))
    expect(chunks[0]).toBe(passthrough[0])
    expect(chunks[1]).toBe(passthrough[1])
    expect(chunks[2]).toBe(passthrough[2])
  })

  it('degrades open on restore failure: warns and passes the chunk through masked', async () => {
    const tiny = new Engine({ maxOutputBytes: 8 })
    const session = tiny.newSession()
    session.anonymize(`call ${PHONE}`) // cap applies to restorers, not this seed
    const warns: string[] = []
    const chunks = await collect(
      restoreStream(chunkStream([
        { type: 'text-delta', index: 0, text: 'short' },
        { type: 'text-delta', index: 0, text: ' exceeds the output cap easily' },
      ]), session, (m) => warns.push(m)),
    )
    expect(warns.length).toBeGreaterThan(0)
    expect((chunks[0] as { text: string }).text).toBe('short')
    // The failing chunk arrives un-restored rather than killing the stream.
    expect((chunks[1] as { text: string }).text).toBe(' exceeds the output cap easily')
  })
})
