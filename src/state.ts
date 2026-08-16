import { Engine, Session } from 'llmasking'

/**
 * One llmasking Session per dsh session, held in memory.
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
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly engine: Engine) {}

  /** The (lazily created) masking Session for a dsh session. */
  sessionFor(sessionId: string): Session {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = this.engine.newSession()
      this.sessions.set(sessionId, session)
    }
    return session
  }

  /** Plugin teardown: drops every mapping. */
  dispose(): void {
    this.sessions.clear()
  }
}
