import { Storage } from '@dcl/sdk/server'
import { enqueueWrite } from './storageWriteQueue'
import { normalizeUserId, sortedPairKey, sortedPairMembers } from './persistenceSchema'
import { PersistedTopMatchEntryV1, TOP_MATCHES_SCHEMA_VERSION, TOP_MATCHES_KEY_PREFIX, topMatchesKeyFor, sanitizeTopMatchEntry } from './topMatchesSchema'

// -----------------------------------------------------------------------
// TOP MATCHES - ALL TIME (backend only) - a derived/mirror index of PAIRS,
// own Storage writes (scene-scoped, via Storage.set/getValues, same as
// leaderboardManager.ts), own in-memory cache, own pending-sync bookkeeping.
// Never the source of truth for a pair's counters - each player's own
// Connections profile (persistenceManager.ts) is. The only thing this shares
// with Connections/Social Points/the leaderboard is the write queue
// (storageWriteQueue.ts) - no two Storage writes from this server process
// are ever in flight at the same time, regardless of domain.
//
// KEY DIFFERENCE FROM THE LEADERBOARD MIRROR: a leaderboard entry has exactly
// ONE authoritative source (that one player's own Social Points profile), so
// scheduleLeaderboardSync always simply overwrites with the latest absolute
// value. A Top Matches entry has TWO independent possible sources - either
// side of the pair's own Connections write can call scheduleTopMatchSync -
// and those two sources can genuinely diverge temporarily if one side's
// Storage write fails (see persistenceManager.ts's own doc comments on
// applyDeltaToPlayer). To stay correct under that divergence without ever
// creating two entries (A<->B and B<->A) for the same pair, every write here
// is a MONOTONIC MERGE (max of each counter, never an overwrite) into the
// ONE entry identified by sortedPairKey() - see mergeTopMatchSnapshot below.
// -----------------------------------------------------------------------

const TOP_MATCHES_HYDRATION_PAGE_SIZE = 100

/** Canonical mirror of confirmed scene-scoped Top Matches entries - populated by hydrateTopMatchesCache() attempts, kept current by every successful flush after that. */
const topMatchEntries = new Map<string, PersistedTopMatchEntryV1>()

/**
 * Latest-known-canonical merged snapshot awaiting a scene-scoped Storage.set,
 * keyed by pairKey - never a queue of deltas, and never a plain overwrite:
 * every write into this map goes through mergeTopMatchSnapshot, so several
 * snapshots arriving for the same pair before a flush lands (from either
 * side of the pair, or from hydration catching up) always coalesce
 * monotonically into one, never let an older/lower snapshot replace a
 * newer/higher one. Also doubles as the hydration buffer: while a hydration
 * attempt is in progress, requestTopMatchFlush() refuses to write anything -
 * see hydrationInProgress below.
 */
const pendingTopMatchSyncs = new Map<string, PersistedTopMatchEntryV1>()

/** Guards against queuing more than one flush attempt per pair at a time - mirrors leaderboardManager.ts's flushInFlight, own Set, keyed by pairKey. */
const flushInFlight = new Set<string>()

/** True for the exact duration of one hydrateTopMatchesCache() paging attempt - mirrors leaderboardManager.ts's hydrationInProgress exactly, own flag, own module. */
let hydrationInProgress = false

/** True only once a FULL paging sweep has completed with no getValues error - mirrors leaderboardManager.ts's hydrationFullyLoaded. */
let hydrationFullyLoaded = false

/** The in-flight attempt's promise, or null when no attempt is currently running - mirrors leaderboardManager.ts's hydrationPromise, reset to null the moment an attempt ends so a later call always starts fresh. */
let hydrationPromise: Promise<void> | null = null

/**
 * Merges `incoming` into `current` (if any) with monotonic max on both
 * counters - the core invariant that makes it safe for either side of a pair
 * to send a snapshot without ever needing to know which side is "ahead":
 * whichever value is larger always wins, so a lagging/retried snapshot from
 * one side can never regress an already-more-advanced value the other side
 * already delivered. `pairKey`/`userA`/`userB` always come from `incoming`
 * (every caller already computes them via sortedPairKey/sortedPairMembers,
 * so they're identical to `current`'s own whenever `current` exists - never
 * actually a meaningful choice between the two). Display names are NOT
 * monotonic - `incoming`'s name wins if present (a fresher observation),
 * otherwise `current`'s is kept, so a snapshot with unchanged/lower counters
 * can still refresh a name.
 */
function mergeTopMatchSnapshot(
    current: PersistedTopMatchEntryV1 | undefined,
    incoming: {
        pairKey: string
        userA: string
        userB: string
        sameAnswers: number
        differentAnswers: number
        displayNameA?: string
        displayNameB?: string
    }
): PersistedTopMatchEntryV1 {
    return {
        version: TOP_MATCHES_SCHEMA_VERSION,
        pairKey: incoming.pairKey,
        userA: incoming.userA,
        userB: incoming.userB,
        sameAnswers: Math.max(current?.sameAnswers ?? 0, incoming.sameAnswers),
        differentAnswers: Math.max(current?.differentAnswers ?? 0, incoming.differentAnswers),
        displayNameA: incoming.displayNameA ?? current?.displayNameA,
        displayNameB: incoming.displayNameB ?? current?.displayNameB
    }
}

function requestTopMatchFlush(pairKey: string): void {
    if (hydrationInProgress) return // never write while a hydration attempt is actively paginating
    if (flushInFlight.has(pairKey)) return
    flushInFlight.add(pairKey)
    void enqueueWrite(() => flushOneTopMatchEntry(pairKey)).finally(() => flushInFlight.delete(pairKey))
}

/**
 * Writes exactly one pair's latest pending (already-merged) snapshot to its
 * scene-scoped key. Always runs inside enqueueWrite - never called directly.
 * On failure, the pending entry is left exactly as-is so the next retry
 * (either a fresh scheduleTopMatchSync() call or retryPendingTopMatchSyncs()
 * from the tick loop) picks it straight back up - mirrors
 * leaderboardManager.ts's flushOneLeaderboardEntry exactly.
 */
async function flushOneTopMatchEntry(pairKey: string): Promise<void> {
    const pending = pendingTopMatchSyncs.get(pairKey)
    if (!pending) {
        return // nothing left to flush - a previous flush (or a newer one already in flight) already handled it
    }

    let ok: boolean
    try {
        ok = await Storage.set(topMatchesKeyFor(pairKey), pending)
    } catch (err) {
        console.error(`[TopMatches][SERVER] Storage.set threw for pair ${pairKey}: ${err instanceof Error ? err.message : String(err)}`)
        ok = false
    }

    if (!ok) {
        console.error(`[TopMatches][SERVER] Storage.set returned false for pair ${pairKey} - mirror stays stale, will retry`)
        return
    }

    // Only clear the pending entry if it's still exactly the one just written -
    // a newer (already-merged) snapshot may have been coalesced in while this
    // write was in flight; that newer one stays pending for the next flush.
    if (pendingTopMatchSyncs.get(pairKey) === pending) {
        pendingTopMatchSyncs.delete(pairKey)
    }
    topMatchEntries.set(pairKey, pending)
}

/**
 * Entry point called by EITHER side of a pair once its own Connections write
 * for that pair has confirmed SAVED (see persistenceManager.ts's
 * processRoundPair) - never on a mere dedupe/ALREADY_PROCESSED hit, same gate
 * Social Points bonuses and the leaderboard sync already use. `userIdX`/
 * `counters` are the CALLING side's own view of the relationship (its own
 * sameAnswers/differentAnswers about `userIdY`) - inherently a valid absolute
 * snapshot for the pair, since a "same answer" round is the same fact from
 * either side's perspective. `displayNameX`/`displayNameY` are that side's own
 * observed names for itself and its partner, in that same X/Y order - this
 * function re-maps them onto userA/userB AFTER computing the canonical order,
 * so the stored displayNameA/displayNameB always correspond correctly to
 * userA/userB regardless of which side or order called this.
 */
export function scheduleTopMatchSync(
    userIdX: string,
    userIdY: string,
    counters: { sameAnswers: number; differentAnswers: number },
    displayNameX: string | undefined,
    displayNameY: string | undefined
): void {
    const pairKey = sortedPairKey(userIdX, userIdY)
    const [userA, userB] = sortedPairMembers(userIdX, userIdY)
    const normalizedX = normalizeUserId(userIdX)
    const displayNameA = normalizedX === userA ? displayNameX : displayNameY
    const displayNameB = normalizedX === userA ? displayNameY : displayNameX

    const existingPending = pendingTopMatchSyncs.get(pairKey)
    const existingCached = topMatchEntries.get(pairKey)
    const baseline = existingPending ?? existingCached

    const merged = mergeTopMatchSnapshot(baseline, {
        pairKey,
        userA,
        userB,
        sameAnswers: counters.sameAnswers,
        differentAnswers: counters.differentAnswers,
        displayNameA,
        displayNameB
    })

    pendingTopMatchSyncs.set(pairKey, merged) // always coalesce monotonically, even while a hydration attempt is in progress
    requestTopMatchFlush(pairKey) // no-ops on its own while hydrationInProgress
}

/**
 * Called every server tick, unconditionally - NOT gated on RESULT phase,
 * same reasoning as retryPendingLeaderboardSyncs: a pending mirror sync can
 * still need retrying long after the RESULT that produced it has ended.
 * Identical policy to leaderboardManager.ts's own retry function, own module.
 */
export function retryPendingTopMatchSyncs(): void {
    if (hydrationInProgress) return

    if (pendingTopMatchSyncs.size > 0 || flushInFlight.size > 0) {
        for (const pairKey of [...pendingTopMatchSyncs.keys()]) {
            requestTopMatchFlush(pairKey)
        }
        return
    }

    if (!hydrationFullyLoaded) {
        void hydrateTopMatchesCache()
    }
}

/**
 * Pages through every persisted Top Matches entry via Storage.getValues -
 * explicit offset/limit pagination against pagination.total, never assuming
 * one call returns everything. hydrationInProgress is true for this
 * function's entire duration, so requestTopMatchFlush() refuses every write
 * until this attempt ends. Mirrors leaderboardManager.ts's
 * hydrateLeaderboardCache exactly, with one addition specific to this
 * domain: if a pending snapshot already exists for a pair being hydrated
 * (a live round updated it before this hydration attempt reached that pair),
 * it is merged monotonically against the freshly-loaded entry - not just a
 * name backfill like the leaderboard does, because unlike a Social Points
 * profile (always the single full authoritative source before any
 * increment), a Top Matches pending snapshot built before hydration finished
 * may be missing counters that were already durably stored from a PREVIOUS
 * session. Without this merge, flushing that pending snapshot as-is could
 * regress an already-higher stored value - exactly what the monotonic
 * guarantee exists to prevent.
 */
export function hydrateTopMatchesCache(): Promise<void> {
    if (hydrationInProgress && hydrationPromise) return hydrationPromise
    if (hydrationFullyLoaded) return Promise.resolve()

    hydrationInProgress = true
    hydrationPromise = (async () => {
        let offset = 0
        let cleanRun = true

        for (;;) {
            let page: { data: Array<{ key: string; value: unknown }>; pagination: { offset: number; total: number } }
            try {
                page = await Storage.getValues({ prefix: TOP_MATCHES_KEY_PREFIX, limit: TOP_MATCHES_HYDRATION_PAGE_SIZE, offset })
            } catch (err) {
                console.error(
                    `[TopMatches][SERVER] hydration getValues failed at offset ${offset} - aborting this attempt, will retry once the mirror is quiet: ${
                        err instanceof Error ? err.message : String(err)
                    }`
                )
                cleanRun = false
                break
            }

            for (const { key, value } of page.data) {
                const entry = sanitizeTopMatchEntry(value)
                if (!entry) {
                    console.error(`[TopMatches][SERVER] skipping malformed Top Matches entry at key '${key}'`)
                    continue
                }
                if (topMatchesKeyFor(entry.pairKey) !== key) {
                    console.error(`[TopMatches][SERVER] skipping inconsistent Top Matches entry: key '${key}' does not match its own pairKey '${entry.pairKey}'`)
                    continue
                }

                topMatchEntries.set(entry.pairKey, entry)

                // Monotonic merge, not a plain backfill - see this function's own doc
                // comment for why a pending snapshot can genuinely be missing counters
                // hydration just found in Storage.
                const pending = pendingTopMatchSyncs.get(entry.pairKey)
                if (pending) {
                    pendingTopMatchSyncs.set(entry.pairKey, mergeTopMatchSnapshot(entry, pending))
                }
            }

            offset += page.data.length
            if (page.data.length === 0 || offset >= page.pagination.total) break
        }

        hydrationInProgress = false
        hydrationFullyLoaded = cleanRun
        hydrationPromise = null // never memoize a finished attempt - see this function's own doc comment

        // Flush whatever accumulated while this attempt was running.
        for (const pairKey of [...pendingTopMatchSyncs.keys()]) {
            requestTopMatchFlush(pairKey)
        }
    })()

    return hydrationPromise
}

/**
 * Read-only snapshot of every confirmed cache entry, for callers (the ranking
 * layer) that must never hold a reference to the live, mutable Map or its
 * stored objects - mirrors leaderboardManager.ts's getLeaderboardCacheSnapshot.
 */
export function getTopMatchesCacheSnapshot(): PersistedTopMatchEntryV1[] {
    return [...topMatchEntries.values()].map((entry) => ({ ...entry }))
}

/** True only once a full hydration paging sweep has completed cleanly - see hydrationFullyLoaded's own doc comment above. Callers must treat `false` as "the index may be incomplete," never partial-but-good-enough. */
export function isTopMatchesFullyLoaded(): boolean {
    return hydrationFullyLoaded
}
