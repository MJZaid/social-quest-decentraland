import { SharedPhase, RoundStateValue } from './networkRoundState'
import { getNewConnectionsFromLastRound } from './connectionsManager'
import { persistenceRoom } from './persistenceMessages'

// -----------------------------------------------------------------------
// SOCIAL NOTIFICATIONS MANAGER - client-side "unseen Connections" tracking
// for the Social Agenda badge/reveal, fully separate from Connections' own
// data (connectionsManager.ts). This module never mutates a ConnectionRecord
// and never adds a seen/new field to it - it only ever answers "which
// Connections has this player not yet had revealed inside Social Agenda",
// backed by its own small persisted domain (socialQuestNotificationsV1 - see
// persistenceSchema.ts / persistenceManager.ts).
//
// Two independent sources feed the in-memory unseenConnectionIds Set:
// - LIVE (this session): tick() below, called from roundManager.tick()
//   alongside connectionCelebration.tick()/socialCelebrationQueue.tick() - an
//   independent THIRD consumer of connectionsManager's own
//   getNewConnectionsFromLastRound(), the exact same already-correct
//   "genuinely brand new Connection" signal celebration already uses.
//   Neither connectionsManager.ts nor connectionCelebration.ts needed any
//   change for this.
// - HYDRATED (from a previous session): hydrateUnseenConnections(), called
//   once from persistenceManager.ts's own profileResponse handler, the same
//   message/moment Connections' own hydrateConnections() runs.
//
// Both sources only ever ADD to unseenConnectionIds. Removal happens
// exclusively via removeSeenIdsLocally(), driven by ui.tsx's reveal flow -
// mirroring the server's own "exact diff, never clear-all" contract
// (persistenceManager.ts's removeSeenConnections) on the client side too.
// -----------------------------------------------------------------------

function normalize(userId: string): string {
    return userId.trim().toLowerCase()
}

const unseenConnectionIds = new Set<string>()
/**
 * Every id ever added to unseenConnectionIds this session, NEVER removed
 * (unlike unseenConnectionIds itself) - the dedup guard for tick()'s live
 * signal. Without this, revealing a Connection (removing it from
 * unseenConnectionIds) while that same round's RESULT window is still
 * active - getNewConnectionsFromLastRound() holds a round's new ids for its
 * whole RESULT phase, not just once - would make tick() see the id "missing"
 * from unseenConnectionIds and incorrectly re-add it right after the player
 * just revealed it.
 */
const everAddedToUnseen = new Set<string>()

/** NOT_READY until hydrateUnseenConnections() has run once this session. */
let hydrated = false

/** IDs that arrived live (via tick()) since the last drainPendingReveal() call - a queue to consume once, never something to poll/diff. */
let pendingReveal: string[] = []

/**
 * Called from roundManager.tick(), same cadence/spot as
 * connectionCelebration.tick()/socialCelebrationQueue.tick(). Reads
 * connectionsManager's own getNewConnectionsFromLastRound() - already
 * exactly "the ids that just became a genuinely new Connection this round",
 * never hydration/reconciliation/ALREADY_PROCESSED/a milestone/an existing
 * partner's rounds or Affinity changing (see that function's own guarantees).
 */
export function tick(state: RoundStateValue): void {
    if (state.phase !== SharedPhase.RESULT) return

    for (const userId of getNewConnectionsFromLastRound()) {
        const id = normalize(userId)
        if (everAddedToUnseen.has(id)) continue
        everAddedToUnseen.add(id)
        unseenConnectionIds.add(id)
        pendingReveal.push(id)
    }
}

/** Current badge count - 0 both while genuinely zero and while NOT_READY (nothing hydrated/added yet); see isNotificationsHydrated() for distinguishing the two if ever needed. */
export function getUnseenConnectionCount(): number {
    return unseenConnectionIds.size
}

/** Snapshot of every currently-unseen id, normalized - used by ui.tsx's reveal-on-open flow. Never mutates the Set. */
export function getUnseenConnectionIds(): string[] {
    return [...unseenConnectionIds]
}

/** Removes exactly these ids - never a clear-all, mirrors the server's own exact-diff contract (persistenceManager.ts's removeSeenConnections). Safe to call with ids already absent (idempotent no-op per id). */
export function removeSeenIdsLocally(ids: string[]): void {
    for (const id of ids) {
        unseenConnectionIds.delete(normalize(id))
    }
}

/** Atomically returns and clears whatever arrived live since the last call - a drained queue, not something to poll/diff; empty on every call except the rare one right after tick() actually added something new. */
export function drainPendingReveal(): string[] {
    if (pendingReveal.length === 0) return []
    const drained = pendingReveal
    pendingReveal = []
    return drained
}

export function isNotificationsHydrated(): boolean {
    return hydrated
}

/**
 * Seeds the Set from a previous session's persisted unseen list - called
 * once, from persistenceManager.ts's profileResponse handler, the same
 * moment Connections' own hydrateConnections() runs. Always MERGES (adds),
 * never replaces the Set outright - a live id already added by tick() before
 * this arrives (the hydration-race window) must survive, exactly like
 * hydrateConnections() itself never overwrites this session's own live
 * progress.
 */
export function hydrateUnseenConnections(persistedIds: string[]): void {
    for (const rawId of persistedIds) {
        const id = normalize(rawId)
        everAddedToUnseen.add(id)
        unseenConnectionIds.add(id)
    }
    hydrated = true
}

/** Sends the exact ids just revealed to the server for durable removal - fire-and-forget, no response expected (see persistenceMessages.ts's markConnectionsSeen). No-op for an empty list - never worth a round trip. */
export function requestMarkConnectionsSeen(ids: string[]): void {
    if (ids.length === 0) return
    persistenceRoom.send('markConnectionsSeen', { connectionIdsJson: JSON.stringify(ids.map(normalize)) })
}
