import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, type Config } from '../src/index.js'
import { collect, EMAIL, PHONE, SECRET_KEY, userMessage } from './helpers.js'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { keywords: [], regions: [], maskSystem: true, teachModel: false, ...overrides }
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'fake',
    model: 'fake-model',
    messages: [userMessage(`my number is ${PHONE}, mail ${EMAIL}`)],
    system: `user is reachable at ${EMAIL}`,
    sessionId: 'sess-1' as GenerateOptions['sessionId'],
    ...overrides,
  }
}

interface FakeSystemPrompt {
  sections: Array<{ name: string; order: number; text: string }>
  section(section: { name: string; order: number; text: string }): () => void
}

/**
 * Minimal stand-in for a cordis Context: enough surface for apply() to
 * register, plus a fake `llm` service whose stream() re-dispatches through
 * the captured listener — simulating dsh's waterfall, where our own
 * re-dispatch enters the SAME event chain and next() reaches the adapter.
 * The `sessions` store is a throwing canary: this plugin must never touch
 * it (no custom session events, no session-store reads).
 */
function makeFakeCtx() {
  const handlers = new Map<string, Array<(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>>>()
  const disposers: Array<() => void> = []
  const injects: Array<{ deps: string[]; callback: (ctx: unknown) => void }> = []
  const systemPrompt: FakeSystemPrompt = {
    sections: [],
    section(section) {
      systemPrompt.sections.push(section)
      return () => {}
    },
  }
  const seen: GenerateOptions[] = []
  let adapter: ((options: GenerateOptions) => StreamChunk[]) | undefined

  const ctx = {
    on: (name: string, handler: (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
    effect: (fn: () => () => void) => {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    inject: (deps: string[], callback: (ctx: unknown) => void) => {
      injects.push({ deps, callback })
    },
    sessions: {
      get() {
        throw new Error('plugin must not touch the session store')
      },
    },
    logger: {
      warn: () => {},
    },
    llm: {
      // The real waterfall: our re-dispatch comes back through here, the
      // listener runs again (marker → next()), and next() lands in the
      // fake adapter below.
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        const listener = handlers.get('llm/stream')?.[0]
        if (!listener) throw new Error('no llm/stream listener registered')
        return listener(options, () => adapterStream(options))
      },
    },
  }
  function adapterStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () {
      const chunks = adapter?.(options)
      if (!chunks) return
      yield* chunks
    })()
  }

  return {
    ctx: ctx as unknown as Context,
    seen,
    injects,
    systemPrompt,
    disposers,
    setAdapter(impl: (options: GenerateOptions) => StreamChunk[]) {
      adapter = (options) => {
        seen.push(options)
        return impl(options)
      }
    },
    /** Drive the waterfall exactly as dsh would for a first dispatch. */
    dispatch(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const listener = handlers.get('llm/stream')?.[0]
      if (!listener) throw new Error('no llm/stream listener registered')
      return listener(options, () => adapterStream(options))
    },
  }
}

describe('dsh-llmasking plugin (waterfall simulation)', () => {
  it('end to end: the adapter sees only placeholders; dsh consumes restored real values', async () => {
    const fx = makeFakeCtx()
    apply(fx.ctx, makeConfig())
    fx.setAdapter((received) => {
      // ZERO-LEAK assertion, inside the fake adapter: nothing sensitive
      // ever reaches provider-side code.
      const wire = JSON.stringify(received)
      expect(wire).not.toContain(PHONE)
      expect(wire).not.toContain(EMAIL)
      expect(wire).not.toContain(SECRET_KEY)
      expect(wire).toContain('[PHONE_1]')
      expect(wire).toContain('[EMAIL_1]')
      return [
        { type: 'text-delta', index: 0, text: 'calling ' },
        { type: 'text-delta', index: 0, text: '[PH' },
        { type: 'text-delta', index: 0, text: `ONE_1] and mailing [EMAIL_1]; key stays [SECRET_1]` },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'calling [PHONE_1] and mailing [EMAIL_1]; key stays [SECRET_1]' } },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1' as never, name: 'write', arguments: '{"path":"note.txt","content":"[PHONE_1]"}' } },
        { type: 'finish', reason: 'stop' as never },
      ]
    })

    const chunks = await collect(fx.dispatch(request({ messages: [userMessage(`${PHONE} ${EMAIL} OPENAI_API_KEY=${SECRET_KEY}`)] })))

    // The model-side request the adapter actually received is the masked
    // re-dispatch, not the original.
    expect(fx.seen.length).toBe(1)
    expect(fx.seen[0]?.messages[0]?.content[0]).toMatchObject({ type: 'text', text: '[PHONE_1] [EMAIL_1] OPENAI_API_KEY=[SECRET_1]' })

    // What dsh consumes (log / UI / tool execution) holds real values,
    // with secrets left as placeholders.
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe(`calling ${PHONE} and mailing ${EMAIL}; key stays [SECRET_1]`)
    const blocks = chunks.filter((c) => c.type === 'block-end')
    expect(blocks[0]).toMatchObject({ block: { type: 'text', text: `calling ${PHONE} and mailing ${EMAIL}; key stays [SECRET_1]` } })
    // Write-back: the tool call the registry will execute carries the real value.
    expect(blocks[1]).toMatchObject({ block: { arguments: `{"path":"note.txt","content":"${PHONE}"}` } })
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: 'stop' })
  })

  it('same value keeps the same placeholder across requests AND across call kinds of one session', async () => {
    const fx = makeFakeCtx()
    apply(fx.ctx, makeConfig())
    fx.setAdapter(() => [{ type: 'finish', reason: 'stop' as never }])
    await collect(fx.dispatch(request()))
    // An auxiliary call (session-title shaped: same sessionId, purpose set)
    // shares the mapping — the phone is still [PHONE_1], not [PHONE_2].
    await collect(fx.dispatch(request({ purpose: 'session-title', messages: [userMessage(`title for ${PHONE}`)] })))
    const first = JSON.stringify(fx.seen[0])
    const second = JSON.stringify(fx.seen[1])
    expect(first).toContain('[PHONE_1]')
    expect(second).toContain('[PHONE_1]')
    expect(second).not.toContain('[PHONE_2]')
  })

  it('sessionId-less one-shots get their own ephemeral mapping (no cross-conversation bleed)', async () => {
    const fx = makeFakeCtx()
    apply(fx.ctx, makeConfig())
    fx.setAdapter(() => [{ type: 'finish', reason: 'stop' as never }])
    await collect(fx.dispatch(request({ sessionId: undefined, messages: [userMessage(PHONE)] })))
    await collect(fx.dispatch(request({ sessionId: undefined, messages: [userMessage(PHONE)] })))
    // A different value in a third anonymous call numbers from 1 again —
    // proving the first two did not share one growing Session.
    await collect(fx.dispatch(request({ sessionId: undefined, messages: [userMessage('13900139000')] })))
    expect(JSON.stringify(fx.seen[2])).toContain('[PHONE_1]') // fresh counter, not [PHONE_2]
  })

  it('sensitive-free requests take the zero-overhead next() path (no re-dispatch)', async () => {
    const fx = makeFakeCtx()
    apply(fx.ctx, makeConfig())
    fx.setAdapter(() => [{ type: 'finish', reason: 'stop' as never }])
    const clean = request({ messages: [userMessage('just a normal question')], system: 'you are helpful' })
    const chunks = await collect(fx.dispatch(clean))
    expect(chunks).toEqual([{ type: 'finish', reason: 'stop' }])
    // next() path only — the adapter saw the ORIGINAL object, exactly once.
    expect(fx.seen.length).toBe(1)
    expect(fx.seen[0]).toBe(clean)
  })

  it('config flows through: keywords mask, regions filter geo packs', async () => {
    const fx = makeFakeCtx()
    apply(fx.ctx, makeConfig({ keywords: ['ZETA-9-ALPHA'], regions: ['CN'] }))
    fx.setAdapter(() => [{ type: 'finish', reason: 'stop' as never }])
    // US-rules disabled by regions:['CN'] → the SSN must pass through raw;
    // the custom keyword must mask.
    await collect(fx.dispatch(request({ messages: [userMessage('token ZETA-9-ALPHA and ssn 123-45-6789')] })))
    const wire = JSON.stringify(fx.seen[0])
    expect(wire).toContain('[KEYWORD_1]')
    expect(wire).toContain('123-45-6789')
  })

  it('fails closed when masking itself errors: the request never reaches the adapter', async () => {
    const fx = makeFakeCtx()
    apply(fx.ctx, makeConfig())
    fx.setAdapter(() => [{ type: 'finish', reason: 'stop' as never }])
    // Force a masking failure with a poisoned message: a content getter
    // that throws.
    const poisoned = {
      get content() {
        throw new Error('poisoned message')
      },
    }
    const bad = request({ messages: [poisoned as unknown as Message] })
    await expect(collect(fx.dispatch(bad))).rejects.toThrow(/refusing to send unmasked/)
    expect(fx.seen.length).toBe(0)
  })

  it('teachModel contributes a system-prompt section through the optional service', () => {
    const withTeach = makeFakeCtx()
    apply(withTeach.ctx, makeConfig({ teachModel: true }))
    expect(withTeach.injects).toEqual([{ deps: ['systemPrompt'], callback: expect.any(Function) }])
    withTeach.injects[0]?.callback({ systemPrompt: withTeach.systemPrompt })
    expect(withTeach.systemPrompt.sections).toEqual([
      { name: 'llmasking', order: 150, text: expect.stringContaining('[PHONE_1]') },
    ])

    const withoutTeach = makeFakeCtx()
    apply(withoutTeach.ctx, makeConfig({ teachModel: false }))
    expect(withoutTeach.injects).toEqual([])
  })

  it('plugin dispose drops all masking state', async () => {
    const OTHER_PHONE = '13900139000'
    const fx = makeFakeCtx()
    apply(fx.ctx, makeConfig())
    fx.setAdapter(() => [{ type: 'finish', reason: 'stop' as never }])

    // Warm the shared Session: OTHER_PHONE takes [PHONE_1] ...
    await collect(fx.dispatch(request({ messages: [userMessage(OTHER_PHONE)] })))
    expect(fx.seen[0]?.messages[0]?.content[0]).toMatchObject({ text: '[PHONE_1]' })
    // ... so PHONE is numbered [PHONE_2] within the same dsh session.
    await collect(fx.dispatch(request({ messages: [userMessage(PHONE)] })))
    expect(fx.seen[1]?.messages[0]?.content[0]).toMatchObject({ text: '[PHONE_2]' })

    // Plugin unload wipes the mapping: the counter starts over.
    for (const dispose of fx.disposers) dispose()
    await collect(fx.dispatch(request({ messages: [userMessage(PHONE)] })))
    expect(fx.seen[2]?.messages[0]?.content[0]).toMatchObject({ text: '[PHONE_1]' })
  })
})
