// -----------------------------------------------------------------------
// TOP MATCHES - ALL TIME - a global, scene-scoped mirror of PAIRS, fully
// separate from the per-player leaderboard (leaderboardSchema.ts) and from
// Connections/Social Points (persistenceSchema.ts). One entry per pair that
// has actually shared at least one valid round, identified by
// sortedPairKey() (persistenceSchema.ts) so the same pair can never end up
// as two different entries regardless of which of its two players' own
// Connections write happened to trigger the update - see
// persistenceManager.ts's scheduleTopMatchSync/mergeTopMatchSnapshot for how
// that's enforced.
// -----------------------------------------------------------------------

/**
 * One pair's Top Matches (ALL TIME) entry. Deliberately minimal:
 * sameAnswers/differentAnswers are the only counters stored -
 * sharedValidAnswers and affinity are NEVER persisted, both are pure
 * derivations via compatibilityManager.ts's getSharedValidAnswers/
 * getCompatibility (see topMatchesRanking.ts) - same discipline this project
 * already applies to socialPoints/questProgress/friendshipLevel. No
 * timestamp - ALL TIME has no temporal ranking concern; THIS WEEK (a later,
 * separate feature) will need its own temporal fields, kept out of this
 * schema on purpose.
 */
export interface PersistedTopMatchEntryV1 {
    version: 1
    /** sortedPairKey(userA, userB) - see persistenceSchema.ts. Also the basis of the Storage key (topMatchesKeyFor); stored again here as a defensive cross-check against key/content mismatch during hydration, same role PersistedLeaderboardEntryV1.userId plays for the leaderboard. */
    pairKey: string
    /** The two members of the pair, in the SAME canonical order sortedPairMembers() itself establishes - never dependent on which side happened to send the snapshot that created or most recently updated this entry. */
    userA: string
    userB: string
    /**
     * Both monotonic - see persistenceManager.ts's mergeTopMatchSnapshot.
     * Whichever of the two players' own Connections profile is more advanced
     * at any given moment can only ever push these UP here, never down - a
     * lagging snapshot from the other side (delayed by, e.g., a retried
     * Storage write) can never regress an already-more-advanced value.
     */
    sameAnswers: number
    differentAnswers: number
    /** Best display name observed for userA/userB respectively - independent of the counters above; can be refreshed by a snapshot whose counters are NOT an improvement. */
    displayNameA?: string
    displayNameB?: string
}

export const TOP_MATCHES_SCHEMA_VERSION = 1
export const TOP_MATCHES_KEY_PREFIX = 'socialQuestTopMatchesV1:'

export function topMatchesKeyFor(pairKey: string): string {
    return `${TOP_MATCHES_KEY_PREFIX}${pairKey}`
}

function isFiniteNonNegativeInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

/** Same validation gate as persistenceSchema.ts's sanitizeDisplayName - a non-empty string after trim(), else undefined. Own copy, own file - schema files in this project deliberately don't share internal validation helpers (see leaderboardSchema.ts). */
function sanitizeTopMatchDisplayName(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Defensively validates/repairs a value loaded from Storage before anything
 * else touches it - same discipline as leaderboardSchema.ts's
 * sanitizeLeaderboardEntry. Returns null (never a default/empty entry - there
 * is no meaningful "empty pair") on any unrecognized shape, wrong version, or
 * corrupted field; topMatchesManager.ts's hydration skips a null result
 * rather than caching it.
 */
export function sanitizeTopMatchEntry(raw: unknown): PersistedTopMatchEntryV1 | null {
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    if (value.version !== TOP_MATCHES_SCHEMA_VERSION) return null
    if (typeof value.pairKey !== 'string' || value.pairKey.length === 0) return null
    if (typeof value.userA !== 'string' || value.userA.length === 0) return null
    if (typeof value.userB !== 'string' || value.userB.length === 0) return null
    if (!isFiniteNonNegativeInt(value.sameAnswers)) return null
    if (!isFiniteNonNegativeInt(value.differentAnswers)) return null

    return {
        version: TOP_MATCHES_SCHEMA_VERSION,
        pairKey: value.pairKey,
        userA: value.userA,
        userB: value.userB,
        sameAnswers: value.sameAnswers,
        differentAnswers: value.differentAnswers,
        displayNameA: sanitizeTopMatchDisplayName(value.displayNameA),
        displayNameB: sanitizeTopMatchDisplayName(value.displayNameB)
    }
}
