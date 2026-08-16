import { Engine, Session } from 'llmasking'

/** Counters for one dsh session (and, in aggregate, since plugin load). */
export interface MaskingStats {
  /** Total number of masked values (one per mask event). */
  maskedCount: number
  /** Number of turns (model requests) that masked at least one value. */
  turnsMasked: number
  /** Histogram of masked values per entity type. */
  readonly entities: ReadonlyMap<string, number>
}

function freshStats(): { maskedCount: number; turnsMasked: number; entities: Map<string, number> } {
  return { maskedCount: 0, turnsMasked: 0, entities: new Map() }
}

/**
 * One llmasking Session per dsh session, held in memory, plus the
 * observability counters layered on top (counts and entity TYPES only —
 * never values; observation must not become a new leak surface).
 *
 * The same-value-same-placeholder dedup living inside a Session keeps
 * placeholder numbering stable across every request of one dsh session —
 * including auxiliary calls (session titles, compaction), which carry the
 * same `sessionId`, so a compaction summary referencing `[PHONE_1]` restores
 * to the same real value the main loop would. Requests WITHOUT a sessionId
 * never touch this map: they are one-shot hand-built calls, so the caller
 * gives each its own ephemeral Session instead of letting unrelated
 * conversations share placeholder numbering.
 *
 * No persistence, deliberately: dsh's log loader refuses event types unknown
 * to the harness, so an out-of-tree plugin appending custom session events
 * would brick resume/fork of that log. None is needed anyway — dsh session
 * logs store REAL values (this plugin restores before anything is logged),
 * so after any restart the next request re-derives real values from the log
 * and re-masks them deterministically. Session methods are synchronous, so
 * overlapping main-loop/title/compaction calls on one Session cannot
 * interleave.
 */
export class MaskingStates {
  private readonly sessions = new Map<string, { session: Session; stats: ReturnType<typeof freshStats> }>()
  private readonly totals = freshStats()

  constructor(private readonly engine: Engine) {}

  /** The (lazily created) masking Session for a dsh session. */
  sessionFor(sessionId: string): Session {
    let entry = this.sessions.get(sessionId)
    if (!entry) {
      entry = { session: this.engine.newSession(), stats: freshStats() }
      this.sessions.set(sessionId, entry)
    }
    return entry.session
  }

  /** Records one masked turn: per-entity counts, per-session and global. */
  record(sessionId: string | undefined, entities: readonly string[]): void {
    if (entities.length === 0) return
    const bump = (stats: { maskedCount: number; turnsMasked: number; entities: Map<string, number> }) => {
      stats.maskedCount += entities.length
      stats.turnsMasked += 1
      for (const entity of entities) stats.entities.set(entity, (stats.entities.get(entity) ?? 0) + 1)
    }
    bump(this.totals)
    if (sessionId === undefined) return
    const entry = this.sessions.get(sessionId)
    if (entry) bump(entry.stats)
  }

  /** Read-only counters for one dsh session, if it ever masked anything. */
  statsFor(sessionId: string): MaskingStats | undefined {
    const entry = this.sessions.get(sessionId)
    return entry && entry.stats.maskedCount > 0 ? entry.stats : undefined
  }

  /** Aggregate counters since plugin load. */
  get totalsView(): MaskingStats {
    return this.totals
  }

  /** Number of dsh sessions holding live mappings. */
  get sessionsTracked(): number {
    return this.sessions.size
  }

  /** Plugin teardown: drops every mapping. */
  dispose(): void {
    this.sessions.clear()
    this.totals.maskedCount = 0
    this.totals.turnsMasked = 0
    this.totals.entities.clear()
  }
}
