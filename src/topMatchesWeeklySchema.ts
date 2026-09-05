// -----------------------------------------------------------------------
// TOP MATCHES - THIS WEEK - a global, scene-scoped, per-week mirror of PAIRS,
// fully separate from ALL TIME (topMatchesSchema.ts/topMatchesManager.ts) and
// from Connections/Social Points (persistenceSchema.ts). Unlike ALL TIME (a
// monotonic merge of two independently-written Connections snapshots), THIS
// WEEK is event-sourced: exactly one +1 per pair/round, observed once at the
// single canonical point in scanCurrentRoundForValidPairs
// (persistenceManager.ts) - see that file's own doc comments for why a
// merge isn't needed here. One entry per pair that shared at least one valid
// round DURING THAT SPECIFIC WEEK, keyed by weekKey (weekKey.ts) +
// sortedPairKey (persistenceSchema.ts).
// -----------------------------------------------------------------------

/**
 * One pair's Top Matches THIS WEEK entry. Deliberately minimal, same
 * discipline as PersistedTopMatchEntryV1 (ALL TIME): sameAnswers/
 * differentAnswers are the only counters - sharedValidAnswers and affinity
 * are NEVER persisted, both are pure derivations via compatibilityManager.ts
 * (see topMatchesWeeklyManager.ts, which reuses topMatchesRanking.ts's
 * buildRankedTopMatches unchanged). No per-round timestamp - weekKey already
 * resolves the temporal scoping this domain needs; nothing here requires
 * knowing exactly when within the week a round happened.
 */
export interface PersistedTopMatchWeeklyEntryV1 {
    version: 1
    /** getWeekKey() value this entry belongs to - see weekKey.ts. Also part of the Storage key (topMatchesWeeklyKeyFor); stored again here as a defensive cross-check against key/content mismatch during hydration, same role PersistedTopMatchEntryV1.pairKey plays for ALL TIME. */
    weekKey: string
    /** sortedPairKey(userA, userB) - see persistenceSchema.ts. */
    pairKey: string
    /** The two members of the pair, in the SAME canonical order sortedPairMembers() establishes. */
    userA: string
    userB: string
    /**
     * Plain event-sourced counters - each +1 comes from exactly one deduped
     * round-pair event (see recentProcessedEventIds below), never a merged
     * snapshot from two independent sources like ALL TIME's. There is only
     * ever one canonical writer per event here, so there is nothing to merge.
     */
    sameAnswers: number
    differentAnswers: number
    /** Best display name observed for userA/userB respectively - can be refreshed by a later event in a later round this same week, independent of the counters. */
    displayNameA?: string
    displayNameB?: string
    /**
     * Bounded circular buffer of already-applied round-pair eventIds for
     * THIS week's entry - see applyWeeklyPairEvent (topMatchesWeeklyManager.ts).
     * Unlike Friendship bonuses, this never needs to remember an eventId
     * forever: once this week has passed, a stale eventId here is simply
     * irrelevant - nothing will ever replay an event for a week that's over.
     */
    recentProcessedEventIds: string[]
}

export const TOP_MATCHES_WEEKLY_SCHEMA_VERSION = 1
export const TOP_MATCHES_WEEKLY_KEY_PREFIX = 'socialQuestTopMatchesWeeklyV1:'
/** Same bound as Connections'/Social Points' own MAX_RECENT_EVENT_IDS (100) - kept as an independent constant since this domain's list is unrelated, but matching the project's existing coherent value rather than inventing a new one. */
export const MAX_RECENT_WEEKLY_EVENT_IDS = 100

/** The scene-scoped Storage prefix for every pair entry within one specific week - used by hydration's Storage.getValues({prefix}) paging, scoped to exactly one week at a time. */
export function topMatchesWeeklyWeekPrefixFor(weekKey: string): string {
    return `${TOP_MATCHES_WEEKLY_KEY_PREFIX}${weekKey}:`
}

/** The exact Storage key for one pair's entry within one specific week. */
export function topMatchesWeeklyKeyFor(weekKey: string, pairKey: string): string {
    return `${topMatchesWeeklyWeekPrefixFor(weekKey)}${pairKey}`
}

function isFiniteNonNegativeInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

/** Same validation gate as topMatchesSchema.ts's own display-name sanitizer - a non-empty string after trim(), else undefined. Own copy, own file - schema files in this project deliberately don't share internal validation helpers. */
function sanitizeTopMatchWeeklyDisplayName(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

export function emptyTopMatchWeeklyEntry(weekKey: string, pairKey: string, userA: string, userB: string): PersistedTopMatchWeeklyEntryV1 {
    return { version: TOP_MATCHES_WEEKLY_SCHEMA_VERSION, weekKey, pairKey, userA, userB, sameAnswers: 0, differentAnswers: 0, recentProcessedEventIds: [] }
}

/**
 * Defensively validates/repairs a value loaded from Storage before anything
 * else touches it - same discipline as topMatchesSchema.ts's
 * sanitizeTopMatchEntry. Returns null (never a default/empty entry - there is
 * no meaningful "empty pair" independent of knowing userA/userB) on any
 * unrecognized shape, wrong version, or corrupted field; hydration and
 * applyWeeklyPairEvent's own load path (topMatchesWeeklyManager.ts) fall back
 * to emptyTopMatchWeeklyEntry() (which does know userA/userB, from the live
 * event) rather than caching a null result.
 */
export function sanitizeTopMatchWeeklyEntry(raw: unknown): PersistedTopMatchWeeklyEntryV1 | null {
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    if (value.version !== TOP_MATCHES_WEEKLY_SCHEMA_VERSION) return null
    if (typeof value.weekKey !== 'string' || value.weekKey.length === 0) return null
    if (typeof value.pairKey !== 'string' || value.pairKey.length === 0) return null
    if (typeof value.userA !== 'string' || value.userA.length === 0) return null
    if (typeof value.userB !== 'string' || value.userB.length === 0) return null
    if (!isFiniteNonNegativeInt(value.sameAnswers)) return null
    if (!isFiniteNonNegativeInt(value.differentAnswers)) return null

    let recentProcessedEventIds: string[] = []
    if (Array.isArray(value.recentProcessedEventIds)) {
        recentProcessedEventIds = value.recentProcessedEventIds.filter((id): id is string => typeof id === 'string').slice(-MAX_RECENT_WEEKLY_EVENT_IDS)
    }

    return {
        version: TOP_MATCHES_WEEKLY_SCHEMA_VERSION,
        weekKey: value.weekKey,
        pairKey: value.pairKey,
        userA: value.userA,
        userB: value.userB,
        sameAnswers: value.sameAnswers,
        differentAnswers: value.differentAnswers,
        displayNameA: sanitizeTopMatchWeeklyDisplayName(value.displayNameA),
        displayNameB: sanitizeTopMatchWeeklyDisplayName(value.displayNameB),
        recentProcessedEventIds
    }
}

/** Appends an eventId, keeping the buffer bounded - a circular window via slice, never a full unbounded log. Mutates `entry` in place, mirroring persistenceSchema.ts's pushProcessedEventId. */
export function pushProcessedWeeklyEventId(entry: PersistedTopMatchWeeklyEntryV1, eventId: string): void {
    entry.recentProcessedEventIds.push(eventId)
    if (entry.recentProcessedEventIds.length > MAX_RECENT_WEEKLY_EVENT_IDS) {
        entry.recentProcessedEventIds = entry.recentProcessedEventIds.slice(-MAX_RECENT_WEEKLY_EVENT_IDS)
    }
}

export function hasProcessedWeeklyEventId(entry: PersistedTopMatchWeeklyEntryV1, eventId: string): boolean {
    return entry.recentProcessedEventIds.includes(eventId)
}
