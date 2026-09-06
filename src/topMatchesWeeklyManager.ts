import { Storage } from '@dcl/sdk/server'
import { enqueueWrite } from './storageWriteQueue'
import { normalizeUserId, sortedPairKey, sortedPairMembers } from './persistenceSchema'
import { getWeekKey } from './weekKey'
import {
    PersistedTopMatchWeeklyEntryV1,
    topMatchesWeeklyWeekPrefixFor,
    topMatchesWeeklyKeyFor,
    emptyTopMatchWeeklyEntry,
    sanitizeTopMatchWeeklyEntry,
    pushProcessedWeeklyEventId,
    hasProcessedWeeklyEventId
} from './topMatchesWeeklySchema'
import { buildRankedTopMatches, clampTopN, TopMatchesSnapshot } from './topMatchesRanking'

// -----------------------------------------------------------------------
// TOP MATCHES - THIS WEEK (backend only) - a derived index of PAIRS, own
// Storage writes (scene-scoped), own in-memory state, fully independent from
// ALL TIME (topMatchesManager.ts) and from Connections/Social Points
// (persistenceManager.ts). The only thing shared with any of them is the
// write queue (storageWriteQueue.ts) - a failure here can never corrupt or
// block ALL TIME, and vice versa.
//
// KEY DIFFERENCE FROM ALL TIME: a Top Matches ALL TIME entry is a monotonic
// MERGE of two independently-written Connections snapshots (either side of a
// pair can report). THIS WEEK cannot use that approach - Connections has no
// per-round timestamp, so its accumulated counters can never be broken down
// by week. THIS WEEK is event-sourced instead: exactly ONE canonical +1 per
// pair/round, applied via a plain idempotent counter increment (the same
// read-check-write-retry shape persistenceManager.ts's own
// applySocialPointsEvent already uses) - there is only one writer per event,
// so there is nothing to merge.
//
// RANKING IS REUSED, NOT DUPLICATED: PersistedTopMatchWeeklyEntryV1 carries
// every field topMatchesRanking.ts's buildRankedTopMatches() actually reads
// (pairKey/userA/userB/displayNameA/displayNameB/sameAnswers/differentAnswers) -
// TypeScript's structural typing allows passing this array directly, with no
// cast and no change to that file, since it never touches the extra fields
// (weekKey/recentProcessedEventIds) this schema adds on top.
// -----------------------------------------------------------------------

const TOP_MATCHES_WEEKLY_HYDRATION_PAGE_SIZE = 100
/** THIS WEEK's own minimum - a pair needs at least this many shared valid answers to appear in the weekly ranking. Deliberately its own product decision, independent of ALL TIME's own (20) - see getTopMatchesThisWeek below, the only caller that applies it. */
const THIS_WEEK_MIN_SHARED_ANSWERS = 5

/**
 * Canonical in-memory entries, keyed by a COMPOSITE key (`${weekKey}:${pairKey}`)
 * - deliberately NOT scoped to only the current week. This is what makes a
 * retry for an OLD week (a Sunday-night event still retrying after Monday's
 * rollover - see applyWeeklyPairEvent/checkTopMatchesWeeklyRollover) safe:
 * the write path addresses entries by their OWN weekKey, never by whatever
 * `currentWeekKey` happens to be at the moment it runs. Only ever populated
 * from a confirmed Storage.get (LOADED or MISSING) or a confirmed
 * Storage.set commit - never from a failed read, same invariant
 * persistenceManager.ts's loadProfile/loadSocialPointsProfile enforce for
 * Connections/Social Points.
 */
const weeklyEntries = new Map<string, PersistedTopMatchWeeklyEntryV1>()
/** Composite keys currently mid-load, so a second caller arriving before the first Storage.get() resolves doesn't race it - mirrors loadingInFlight in persistenceManager.ts. */
const weeklyLoadingInFlight = new Map<string, Promise<{ entry: PersistedTopMatchWeeklyEntryV1; loadedSuccessfully: boolean }>>()

/** The week currently shown by the ranking/hydration cache - changes at most once a week, detected every tick (see checkTopMatchesWeeklyRollover). Initialized eagerly at module load so a boot-time hydration always targets a real value. */
let currentWeekKey: string = getWeekKey(Date.now())

let hydrationInProgress = false
let hydrationFullyLoaded = false
let hydrationPromise: Promise<void> | null = null

function weeklyCompositeKey(weekKey: string, pairKey: string): string {
    return `${weekKey}:${pairKey}`
}

/**
 * Loads one pair's entry for one specific week, distinguishing a confirmed
 * read (real data, or confirmed-absent - `raw === null` - both
 * `loadedSuccessfully: true`) from a failed Storage.get
 * (`loadedSuccessfully: false`) - identical discipline to
 * persistenceManager.ts's loadProfile/loadSocialPointsProfile, and for the
 * exact same reason: caching a failed read as if it were a confirmed empty
 * entry would let a later increment silently overwrite real same/different
 * counts the moment Storage.get next failed.
 *
 * This is the "targeted load" that makes retrying an OLD week's event safe
 * after a rollover: it always tries `weeklyEntries` first (the in-memory
 * cache, ANY week), and falls back to a direct Storage.get for that exact
 * (weekKey, pairKey) - never assuming the entry must already be hydrated
 * just because it belongs to a week that isn't `currentWeekKey` anymore.
 */
async function loadWeeklyEntry(
    weekKey: string,
    pairKey: string,
    userA: string,
    userB: string
): Promise<{ entry: PersistedTopMatchWeeklyEntryV1; loadedSuccessfully: boolean }> {
    const compositeKey = weeklyCompositeKey(weekKey, pairKey)
    const existing = weeklyEntries.get(compositeKey)
    if (existing) return { entry: existing, loadedSuccessfully: true }

    const inFlight = weeklyLoadingInFlight.get(compositeKey)
    if (inFlight) return inFlight

    const promise = (async (): Promise<{ entry: PersistedTopMatchWeeklyEntryV1; loadedSuccessfully: boolean }> => {
        try {
            const raw = await Storage.get<unknown>(topMatchesWeeklyKeyFor(weekKey, pairKey), { fresh: true })
            const entry = raw === null ? emptyTopMatchWeeklyEntry(weekKey, pairKey, userA, userB) : (sanitizeTopMatchWeeklyEntry(raw) ?? emptyTopMatchWeeklyEntry(weekKey, pairKey, userA, userB))
            weeklyEntries.set(compositeKey, entry) // confirmed read (LOADED or MISSING) - safe to cache and safe to write from
            return { entry, loadedSuccessfully: true }
        } catch (err) {
            console.error(
                `[TopMatchesWeekly][SERVER] Storage.get failed for ${compositeKey} - this read is NOT cached and NOT safe to write from; the RESULT-tick rescan that produced this event will attempt a fresh read: ${
                    err instanceof Error ? err.message : String(err)
                }`
            )
            // Deliberately NEVER weeklyEntries.set() here - see this function's own doc comment.
            return { entry: emptyTopMatchWeeklyEntry(weekKey, pairKey, userA, userB), loadedSuccessfully: false }
        } finally {
            weeklyLoadingInFlight.delete(compositeKey)
        }
    })()

    weeklyLoadingInFlight.set(compositeKey, promise)
    return promise
}

/**
 * Applies one pair/round's weekly event exactly once - `same` decides
 * whether sameAnswers or differentAnswers gets +1, never both, never
 * neither. Called from persistenceManager.ts's scanCurrentRoundForValidPairs,
 * once per pair per RESULT-tick scan, using the SAME `same` boolean already
 * computed there (never recomputed here) and a `weekKey` already captured
 * once for this roundId (never `currentWeekKey` - see this function's own
 * "no substitution" rule below).
 *
 * NO MERGE: unlike ALL TIME's scheduleTopMatchSync, there is exactly one
 * canonical caller per event (the single observation point in
 * scanCurrentRoundForValidPairs - see persistenceManager.ts), so this is a
 * plain read-check-increment-write, the same shape as
 * persistenceManager.ts's own applySocialPointsEvent. On failure, nothing
 * about this entry changes at all - not the counters, not
 * recentProcessedEventIds - so the next RESULT-tick rescan (while this round
 * is still live) is free to retry this exact eventId from scratch, with no
 * separate pending/retry system needed - identical reasoning to Connections'
 * own accepted residual risk (a Storage failure spanning this round's ENTIRE
 * RESULT window loses this one round's weekly event permanently - no outbox,
 * no reconciliation source exists for this domain, by product decision).
 *
 * CRITICAL INVARIANT: `weekKey` here is ALWAYS the value the caller captured
 * for this specific roundId - this function never substitutes
 * `currentWeekKey` for it, and never reads the module-level `currentWeekKey`
 * variable at all. This is what keeps a Sunday-23:59:59 event correct even
 * if its write is still retrying after Monday's rollover already moved
 * `currentWeekKey` forward - the event's own weekKey decides where it's
 * written, never "whatever week is current right now."
 */
export async function applyWeeklyPairEvent(
    weekKey: string,
    userIdX: string,
    userIdY: string,
    same: boolean,
    eventId: string,
    displayNameX: string | undefined,
    displayNameY: string | undefined
): Promise<'SAVED' | 'ALREADY_PROCESSED' | 'FAILED'> {
    const pairKey = sortedPairKey(userIdX, userIdY)
    const [userA, userB] = sortedPairMembers(userIdX, userIdY)
    const normalizedX = normalizeUserId(userIdX)
    const displayNameA = normalizedX === userA ? displayNameX : displayNameY
    const displayNameB = normalizedX === userA ? displayNameY : displayNameX

    const { entry: baseline, loadedSuccessfully } = await loadWeeklyEntry(weekKey, pairKey, userA, userB)
    if (!loadedSuccessfully) return 'FAILED'
    if (hasProcessedWeeklyEventId(baseline, eventId)) return 'ALREADY_PROCESSED' // fast path - never even joins the queue

    const compositeKey = weeklyCompositeKey(weekKey, pairKey)
    return enqueueWrite(async (): Promise<'SAVED' | 'ALREADY_PROCESSED' | 'FAILED'> => {
        // Re-check against the CURRENT canonical entry, not `baseline` - mirrors
        // applySocialPointsEvent's own reasoning: another queued write for this
        // same pair/week may have already run its turn.
        const current = weeklyEntries.get(compositeKey) ?? baseline
        if (hasProcessedWeeklyEventId(current, eventId)) return 'ALREADY_PROCESSED'

        const candidate: PersistedTopMatchWeeklyEntryV1 = {
            version: current.version,
            weekKey: current.weekKey,
            pairKey: current.pairKey,
            userA: current.userA,
            userB: current.userB,
            sameAnswers: current.sameAnswers + (same ? 1 : 0),
            differentAnswers: current.differentAnswers + (same ? 0 : 1),
            displayNameA: displayNameA ?? current.displayNameA,
            displayNameB: displayNameB ?? current.displayNameB,
            recentProcessedEventIds: [...current.recentProcessedEventIds]
        }
        pushProcessedWeeklyEventId(candidate, eventId)

        let ok: boolean
        try {
            ok = await Storage.set(topMatchesWeeklyKeyFor(weekKey, pairKey), candidate)
        } catch (err) {
            console.error(`[TopMatchesWeekly][SERVER] Storage.set threw for ${compositeKey}: ${err instanceof Error ? err.message : String(err)}`)
            ok = false
        }
        if (!ok) {
            console.error(`[TopMatchesWeekly][SERVER] Storage.set returned false for ${compositeKey} - this event was not persisted, but gameplay is unaffected`)
            return 'FAILED'
        }

        weeklyEntries.set(compositeKey, candidate) // commit - only now does this become the canonical entry
        return 'SAVED'
    })
}

/**
 * Pages through every persisted entry for `weekKeyToHydrate` via
 * Storage.getValues, scoped to that one week's prefix only - explicit
 * offset/limit pagination against pagination.total, mirrors
 * topMatchesManager.ts's hydrateTopMatchesCache exactly in shape.
 * `weekKeyToHydrate` is captured once at the start (defaults to whatever
 * `currentWeekKey` is at that moment) and used throughout this one sweep,
 * even if `currentWeekKey` itself changes concurrently (an extremely rare
 * race, only possible right at a rollover boundary) - if that happens, the
 * result is treated as stale rather than marking the (now different) current
 * week fully loaded, and the next tick's rollover check starts a fresh
 * attempt for whatever week is current by then.
 */
export function hydrateTopMatchesWeeklyCache(): Promise<void> {
    if (hydrationInProgress && hydrationPromise) return hydrationPromise
    if (hydrationFullyLoaded) return Promise.resolve()

    const weekKeyToHydrate = currentWeekKey
    hydrationInProgress = true
    hydrationPromise = (async () => {
        let offset = 0
        let cleanRun = true

        for (;;) {
            let page: { data: Array<{ key: string; value: unknown }>; pagination: { offset: number; total: number } }
            try {
                page = await Storage.getValues({ prefix: topMatchesWeeklyWeekPrefixFor(weekKeyToHydrate), limit: TOP_MATCHES_WEEKLY_HYDRATION_PAGE_SIZE, offset })
            } catch (err) {
                console.error(
                    `[TopMatchesWeekly][SERVER] hydration getValues failed for week ${weekKeyToHydrate} at offset ${offset} - aborting this attempt, will retry once quiet: ${
                        err instanceof Error ? err.message : String(err)
                    }`
                )
                cleanRun = false
                break
            }

            for (const { key, value } of page.data) {
                const entry = sanitizeTopMatchWeeklyEntry(value)
                if (!entry) {
                    console.error(`[TopMatchesWeekly][SERVER] skipping malformed weekly entry at key '${key}'`)
                    continue
                }
                if (topMatchesWeeklyKeyFor(entry.weekKey, entry.pairKey) !== key) {
                    console.error(`[TopMatchesWeekly][SERVER] skipping inconsistent weekly entry: key '${key}' does not match its own weekKey/pairKey`)
                    continue
                }
                weeklyEntries.set(weeklyCompositeKey(entry.weekKey, entry.pairKey), entry)
            }

            offset += page.data.length
            if (page.data.length === 0 || offset >= page.pagination.total) break
        }

        hydrationInProgress = false
        hydrationPromise = null // never memoize a finished attempt
        // Only mark fully loaded if the week we just hydrated is STILL the current
        // one - see this function's own doc comment for the rare rollover-race case.
        hydrationFullyLoaded = cleanRun && weekKeyToHydrate === currentWeekKey
    })()

    return hydrationPromise
}

/**
 * Called every server tick (see persistenceManager.ts's initPersistenceServer).
 * Detects a week boundary purely by comparing a freshly computed weekKey
 * against the in-memory `currentWeekKey` - no dependency on a server restart
 * ever happening near Monday 00:00 UTC. On a change:
 * - `currentWeekKey` moves to the new week;
 * - every cached entry belonging to the OLD week is dropped from
 *   `weeklyEntries` (memory hygiene only - see loadWeeklyEntry's own doc
 *   comment for why a pruned old-week entry can still be safely re-loaded
 *   on demand via a direct Storage.get if a late event for it arrives);
 * - hydration state resets and a fresh sweep starts for the new week's
 *   prefix.
 *
 * Deliberately does NOT touch Storage at all - no delete, no reset write.
 * The old week's persisted entries stay exactly where they are; they simply
 * stop being part of the currently-hydrated/ranked cache.
 */
export function checkTopMatchesWeeklyRollover(): void {
    const observedWeekKey = getWeekKey(Date.now())
    if (observedWeekKey === currentWeekKey) return

    currentWeekKey = observedWeekKey
    for (const [compositeKey, entry] of weeklyEntries) {
        if (entry.weekKey !== currentWeekKey) {
            weeklyEntries.delete(compositeKey)
        }
    }
    hydrationFullyLoaded = false
    void hydrateTopMatchesWeeklyCache()
}

/** Read-only snapshot of confirmed entries for the CURRENT week only - old-week entries (if any linger between a rollover and their own pruning, or a late retry re-populating one) are excluded so the ranking layer never sees a mix of weeks. */
function getTopMatchesWeeklyCacheSnapshot(): PersistedTopMatchWeeklyEntryV1[] {
    return [...weeklyEntries.values()].filter((entry) => entry.weekKey === currentWeekKey).map((entry) => ({ ...entry }))
}

/**
 * Top `limit` pairs for THIS WEEK, reusing topMatchesRanking.ts's
 * buildRankedTopMatches/clampTopN completely unchanged - see this file's own
 * top comment for why PersistedTopMatchWeeklyEntryV1[] is structurally
 * assignable there with no cast. Applies THIS_WEEK_MIN_SHARED_ANSWERS (5) -
 * ALL TIME applies its own, different minimum (20) at its own call site in
 * topMatchesRanking.ts, never a value shared between the two domains. Same
 * hydration-safety contract as ALL TIME's getTopMatches: status:'hydrating'
 * (empty top, totalPairs:0) until the current week's index is confirmed
 * fully loaded.
 */
export function getTopMatchesThisWeek(limit: number): TopMatchesSnapshot {
    if (!hydrationFullyLoaded) {
        return { status: 'hydrating', totalPairs: 0, top: [] }
    }

    const ranked = buildRankedTopMatches(getTopMatchesWeeklyCacheSnapshot(), THIS_WEEK_MIN_SHARED_ANSWERS)
    return { status: 'ready', totalPairs: ranked.length, top: ranked.slice(0, clampTopN(limit)) }
}

/**
 * One page of THIS WEEK's ranking starting at `offset` - pagination-safe
 * counterpart to getTopMatchesThisWeek above, exactly mirroring
 * topMatchesRanking.ts's own getTopMatches/getTopMatchesPage pairing (see
 * that function's doc comment for the full reasoning: clampTopN's 100-pair
 * cap is right for "top N" but wrong for real page navigation). Same single
 * buildRankedTopMatches call, same THIS_WEEK_MIN_SHARED_ANSWERS threshold, no
 * second ranking pass - only the slice bound changes (offset..offset+pageSize
 * instead of 0..clampTopN(limit)), so every returned entry still carries its
 * correct GLOBAL rank from the one sort already performed.
 */
export function getTopMatchesThisWeekPage(offset: number, pageSize: number): TopMatchesSnapshot {
    if (!hydrationFullyLoaded) {
        return { status: 'hydrating', totalPairs: 0, top: [] }
    }

    const ranked = buildRankedTopMatches(getTopMatchesWeeklyCacheSnapshot(), THIS_WEEK_MIN_SHARED_ANSWERS)
    return { status: 'ready', totalPairs: ranked.length, top: ranked.slice(offset, offset + pageSize) }
}
