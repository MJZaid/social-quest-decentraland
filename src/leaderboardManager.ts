import { Storage } from '@dcl/sdk/server'
import { enqueueWrite } from './storageWriteQueue'
import { PersistedLeaderboardEntryV1, LEADERBOARD_SCHEMA_VERSION, LEADERBOARD_KEY_PREFIX, leaderboardKeyFor, sanitizeLeaderboardEntry } from './leaderboardSchema'

// -----------------------------------------------------------------------
// LEADERBOARD (Phase 2A) - a derived/mirror index, own Storage writes
// (scene-scoped, via Storage.set/getValues), own in-memory cache, own
// pending-sync bookkeeping. Never the source of truth for validRounds - see
// leaderboardSchema.ts. The only thing this shares with Connections/Social
// Points is the write queue (storageWriteQueue.ts), same reasoning as
// Phase 1: no two Storage writes from this server process are ever in
// flight at the same time, regardless of domain.
//
// This module intentionally exposes no client-facing messages, no ranking,
// and no leaderboard read API yet - Phase 2A only builds and keeps the
// index itself correct. That's for a later phase.
// -----------------------------------------------------------------------

const LEADERBOARD_HYDRATION_PAGE_SIZE = 100

/** Canonical mirror of confirmed scene-scoped leaderboard entries - populated by hydrateLeaderboardCache() attempts, kept current by every successful flush after that. */
const leaderboardEntries = new Map<string, PersistedLeaderboardEntryV1>()

/**
 * Latest-known-canonical ABSOLUTE snapshot awaiting a scene-scoped
 * Storage.set, keyed by normalized userId - never a queue of deltas. A
 * player who generates several Social Points saves before this can flush
 * only ever needs their single most-recent validRounds value written, never
 * a replay of every intermediate one (31 -> 32 -> 33 coalesces to writing
 * 33 once). Also doubles as the hydration buffer: while a hydration attempt
 * is in progress, requestFlush() refuses to write anything - see
 * hydrationInProgress below.
 */
const pendingLeaderboardSyncs = new Map<string, PersistedLeaderboardEntryV1>()

/** Guards against queuing more than one flush attempt per user at a time - the pending map above is already the real coalescing point, so a second scheduled flush while one is still in flight would just be a redundant queue entry, not a correctness issue, but this keeps the queue from piling up under a sustained Storage outage. Also read by retryPendingLeaderboardSyncs() to know whether any leaderboard write is currently in flight. */
const flushInFlight = new Set<string>()

/**
 * True for the exact duration of one hydrateLeaderboardCache() paging
 * attempt - from the moment it starts until that attempt's loop ends
 * (success or failure). requestFlush() refuses to write to Storage while
 * this is true, so a leaderboard Storage.set can never happen concurrently
 * with our own Storage.getValues paging - the invariant that keeps
 * hydration's own writes from shifting the key set it is in the middle of
 * reading.
 */
let hydrationInProgress = false

/** True only once a FULL paging sweep has completed with no getValues error. False after a failed/aborted attempt, even though leaderboardEntries may already hold every entry that page successfully returned before the failure - a partial cache is never considered "done" until a clean pass confirms it. */
let hydrationFullyLoaded = false

/** The in-flight attempt's promise, or null when no attempt is currently running. Deliberately reset to null the moment an attempt ends (success or failure) - never memoized forever - so a later call always re-evaluates fresh instead of forever returning a stale finished/failed promise. */
let hydrationPromise: Promise<void> | null = null

function requestFlush(userId: string): void {
    if (hydrationInProgress) return // never write while a hydration attempt is actively paginating
    if (flushInFlight.has(userId)) return
    flushInFlight.add(userId)
    void enqueueWrite(() => flushOneLeaderboardEntry(userId)).finally(() => flushInFlight.delete(userId))
}

/**
 * Writes exactly one user's latest pending snapshot to their scene-scoped
 * key. Always runs inside enqueueWrite - never called directly. On failure,
 * the pending entry is left exactly as-is (not cleared, not touched) so the
 * next retry - either a fresh scheduleLeaderboardSync() call or
 * retryPendingLeaderboardSyncs() from the tick loop - picks it straight back
 * up. Social Points itself is never affected either way: this function only
 * ever runs after that player-scoped write has already succeeded.
 */
async function flushOneLeaderboardEntry(userId: string): Promise<void> {
    const pending = pendingLeaderboardSyncs.get(userId)
    if (!pending) {
        return // nothing left to flush - a previous flush (or a newer one already in flight) already handled it
    }

    let ok: boolean
    try {
        ok = await Storage.set(leaderboardKeyFor(userId), pending)
    } catch (err) {
        console.error(`[Leaderboard][SERVER] Storage.set threw for ${userId}: ${err instanceof Error ? err.message : String(err)}`)
        ok = false
    }

    if (!ok) {
        console.error(`[Leaderboard][SERVER] Storage.set returned false for ${userId} - mirror stays stale, will retry`)
        return
    }

    // Only clear the pending entry if it's still exactly the one just written -
    // a newer snapshot may have been coalesced in while this write was in flight.
    if (pendingLeaderboardSyncs.get(userId) === pending) {
        pendingLeaderboardSyncs.delete(userId)
    }
    leaderboardEntries.set(userId, pending)
}

/**
 * Entry point called ONLY after a player's Social Points profile has been
 * successfully SAVED (Storage.player.set confirmed) - never before, and
 * never on a mere dedupe/ALREADY_PROCESSED hit - OR from a progressive
 * backfill read on connect (see persistenceManager.ts's
 * reconcileLeaderboardSnapshot). Takes ABSOLUTE canonical snapshots of BOTH
 * validRounds and friendshipBonusPoints, never deltas, so repeated or
 * out-of-order calls (a round save, a Friendship bonus award, and a connect-
 * time backfill can all fire independently) always converge on the same
 * latest true state, never accumulate.
 *
 * observedDisplayName follows the same discipline as Connections'
 * resolveObservedDisplayName: server-observed only, never client-claimed. A
 * temporarily unresolved observation (undefined) falls back to whatever name
 * is already known for this user - pending first, then cached - never
 * regressing to "no name" or an artificial fallback.
 */
export function scheduleLeaderboardSync(userId: string, absoluteValidRounds: number, absoluteFriendshipBonusPoints: number, observedDisplayName: string | undefined): void {
    const existingPending = pendingLeaderboardSyncs.get(userId)
    const existingCached = leaderboardEntries.get(userId)
    const carriedName = observedDisplayName ?? existingPending?.lastKnownDisplayName ?? existingCached?.lastKnownDisplayName

    const snapshot: PersistedLeaderboardEntryV1 = {
        version: LEADERBOARD_SCHEMA_VERSION,
        userId,
        validRounds: absoluteValidRounds,
        friendshipBonusPoints: absoluteFriendshipBonusPoints,
        ...(carriedName ? { lastKnownDisplayName: carriedName } : {})
    }
    pendingLeaderboardSyncs.set(userId, snapshot) // always coalesce to latest, even while a hydration attempt is in progress

    requestFlush(userId) // no-ops on its own while hydrationInProgress
}

/**
 * Called every server tick, unconditionally - NOT gated on RESULT phase like
 * the Social Points/Connections scans, since a pending mirror sync can still
 * need retrying long after the RESULT that produced it has ended.
 *
 * Simple V1 policy, in order:
 * 1. A hydration attempt is currently paging - do nothing (never overlap a
 *    write with it; scheduleLeaderboardSync()'s own requestFlush() calls are
 *    already refusing to write for the same reason).
 * 2. There is pending leaderboard work (an unflushed entry, or a flush
 *    already in flight) - retry flushing it. Do NOT start a hydration retry
 *    in this same tick, so a hydration attempt never begins while a write is
 *    still settling.
 * 3. The mirror is fully quiet (no pending, nothing in flight) and the cache
 *    was never fully loaded - safe to retry the paging sweep now.
 */
export function retryPendingLeaderboardSyncs(): void {
    if (hydrationInProgress) return

    if (pendingLeaderboardSyncs.size > 0 || flushInFlight.size > 0) {
        for (const userId of [...pendingLeaderboardSyncs.keys()]) {
            requestFlush(userId)
        }
        return
    }

    if (!hydrationFullyLoaded) {
        void hydrateLeaderboardCache()
    }
}

/**
 * Pages through every persisted leaderboard entry via Storage.getValues -
 * explicit offset/limit pagination against pagination.total, never assuming
 * one call returns everything. hydrationInProgress is true for this
 * function's entire duration, so requestFlush() refuses every leaderboard
 * write until this attempt ends - this server's own writes can never shift
 * the set of keys out from under its own paging.
 *
 * A second call while one attempt is already running returns that SAME
 * attempt's promise rather than starting a concurrent one. Once an attempt
 * ends - success OR failure - hydrationPromise resets to null: this is never
 * memoized forever, so a later call (from retryPendingLeaderboardSyncs, once
 * the mirror is quiet and hydrationFullyLoaded is still false) always starts
 * a genuinely fresh paging sweep rather than replaying a stale result.
 *
 * Never blocks gameplay or Social Points: every caller fires this without
 * awaiting it, and Social Points writes keep succeeding independently the
 * whole time - only the leaderboard mirror is delayed until an attempt
 * completes.
 */
export function hydrateLeaderboardCache(): Promise<void> {
    if (hydrationInProgress && hydrationPromise) return hydrationPromise
    if (hydrationFullyLoaded) return Promise.resolve()

    hydrationInProgress = true
    hydrationPromise = (async () => {
        let offset = 0
        let cleanRun = true

        for (;;) {
            let page: { data: Array<{ key: string; value: unknown }>; pagination: { offset: number; total: number } }
            try {
                page = await Storage.getValues({ prefix: LEADERBOARD_KEY_PREFIX, limit: LEADERBOARD_HYDRATION_PAGE_SIZE, offset })
            } catch (err) {
                console.error(
                    `[Leaderboard][SERVER] hydration getValues failed at offset ${offset} - aborting this attempt, will retry once the mirror is quiet: ${
                        err instanceof Error ? err.message : String(err)
                    }`
                )
                cleanRun = false
                break
            }

            for (const { key, value } of page.data) {
                const entry = sanitizeLeaderboardEntry(value)
                if (!entry) {
                    console.error(`[Leaderboard][SERVER] skipping malformed leaderboard entry at key '${key}'`)
                    continue
                }
                // The key must be exactly what this same entry's own userId would
                // produce - a mismatch (e.g. key 'A' holding a value whose userId is
                // 'B') means the two disagree about whose entry this is. Skip rather
                // than risk contaminating either player's cached entry.
                if (leaderboardKeyFor(entry.userId) !== key) {
                    console.error(`[Leaderboard][SERVER] skipping inconsistent leaderboard entry: key '${key}' does not match its own userId '${entry.userId}'`)
                    continue
                }

                leaderboardEntries.set(entry.userId, entry)

                // Backfill only: if a pending sync for this same user is still
                // missing a display name (never observed since it was scheduled),
                // carry in the older-but-known name Storage just gave us - never
                // touch pending.validRounds, which is always fresher than anything
                // hydration reads, and never overwrite a name pending already has.
                const pending = pendingLeaderboardSyncs.get(entry.userId)
                if (pending && !pending.lastKnownDisplayName && entry.lastKnownDisplayName) {
                    pendingLeaderboardSyncs.set(entry.userId, { ...pending, lastKnownDisplayName: entry.lastKnownDisplayName })
                }
            }

            offset += page.data.length
            if (page.data.length === 0 || offset >= page.pagination.total) break
        }

        hydrationInProgress = false
        hydrationFullyLoaded = cleanRun
        hydrationPromise = null // never memoize a finished attempt - see this function's own doc comment

        // Flush whatever accumulated while this attempt was running - a fresh
        // gameplay update, or (on a failed attempt) work left over from before
        // this attempt even started. Safe now: hydrationInProgress is false.
        for (const userId of [...pendingLeaderboardSyncs.keys()]) {
            requestFlush(userId)
        }
    })()

    return hydrationPromise
}

/** Inspection-only - never wired to any client message. For manual verification during Phase 2A testing. */
export function getLeaderboardEntryForTesting(normalizedUserId: string): PersistedLeaderboardEntryV1 | undefined {
    return leaderboardEntries.get(normalizedUserId)
}

/**
 * Read-only snapshot of every confirmed cache entry, for callers (the
 * ranking layer) that must never hold a reference to the live, mutable
 * Map or its stored objects. A new array AND a shallow copy of each entry
 * every call - the schema is flat/primitives-only (see
 * PersistedLeaderboardEntryV1), so a shallow copy is a real, independent
 * object: a caller mutating a field on a returned entry can never reach
 * back into leaderboardEntries' own canonical object.
 */
export function getLeaderboardCacheSnapshot(): PersistedLeaderboardEntryV1[] {
    return [...leaderboardEntries.values()].map((entry) => ({ ...entry }))
}

/** True only once a full hydration paging sweep has completed cleanly - see hydrationFullyLoaded's own doc comment above. Callers must treat `false` as "the index may be incomplete," never partial-but-good-enough. */
export function isLeaderboardFullyLoaded(): boolean {
    return hydrationFullyLoaded
}
