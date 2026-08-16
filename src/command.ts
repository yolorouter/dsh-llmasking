import { hasMasked, type MaskingStats } from './state.js'

export interface CommandDeps {
  version: string
  mode: 'enforce' | 'monitor'
  regions: readonly string[]
  keywords: readonly string[]
  statsFor(sessionId: string): MaskingStats
  totals(): MaskingStats
  sessionsTracked(): number
  /** Runs the sentinel self-test through the real masking pipeline. */
  verify(): { before: string; after: string; passed: boolean }
}

function renderStats(stats: MaskingStats): string {
  const histogram = [...stats.entities.entries()].map(([entity, n]) => `${entity} ${n}`).join(', ')
  return `${stats.maskedCount} value(s) across ${stats.turnsMasked} masked turn(s)${histogram ? ` — ${histogram}` : ''}`
}

/**
 * The `/llmasking` human command: status receipt, per-session stats, and a
 * local sentinel self-verify. Observation stays count/type shaped — it never
 * prints values.
 */
export function handleLlmaskingCommand(rawInput: string, sessionId: string | undefined, deps: CommandDeps):
  | { kind: 'success'; text: string }
  | { kind: 'error'; text: string } {
  const sub = rawInput.trim().toLowerCase()
  if (sub !== '' && sub !== 'status' && sub !== 'verify') {
    return { kind: 'error', text: 'usage: /llmasking [status|verify]' }
  }

  if (sub === 'verify') {
    const { before, after, passed } = deps.verify()
    return {
      kind: passed ? 'success' : 'error',
      text: [
        `llmasking self-verify: ${passed ? 'PASS' : 'FAIL'}`,
        `  sentinel input : ${before}`,
        `  wire form      : ${after}`,
        passed ? 'The masking pipeline is live: the sentinel value never reaches the wire form.'
          : 'The pipeline did NOT mask the sentinel value — check plugin config and engine detectors.',
      ].join('\n'),
    }
  }

  const totals = deps.totals()
  let sessionLine = 'session: (none in this invocation)'
  if (sessionId !== undefined) {
    const session = deps.statsFor(sessionId)
    sessionLine = `this session: ${hasMasked(session) ? renderStats(session) : 'nothing masked yet'}`
  }
  return {
    kind: 'success',
    text: [
      `llmasking v${deps.version} — transport-layer masking`,
      `mode: ${deps.mode}${deps.mode === 'monitor' ? ' (NOT enforcing: real values reach the provider)' : ''}`,
      `detectors: regions ${deps.regions.length > 0 ? deps.regions.join('+') : 'all'}, keywords ${deps.keywords.length}`,
      sessionLine,
      `since load: ${renderStats(totals)}; ${deps.sessionsTracked()} session(s) mapped`,
    ].join('\n'),
  }
}
