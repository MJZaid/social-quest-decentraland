// -----------------------------------------------------------------------
// LEADERBOARD (Phase 2A) - a derived/mirror index of Social Points progress,
// scene-scoped (Storage.get/set/getValues), NEVER the source of truth.
// socialQuestPointsProfileV1 (Storage.player, see persistenceSchema.ts) is
// and remains the sole authority for validRounds - this index only mirrors
// it for future discovery/leaderboard use. If the two ever disagree, the
// player-scoped Social Points profile wins, always.
// -----------------------------------------------------------------------

/**
 * One player's mirrored entry in the global scene-scoped leaderboard index.
 * Deliberately minimal, same discipline as PersistedSocialPointsProfileV1 in
 * persistenceSchema.ts: socialPoints/questProgress/rank are NEVER stored
 * here - all are pure derivations of validRounds (getSocialPoints/
 * getQuestProgress in persistenceSchema.ts), computed by callers, so this
 * index can never itself drift out of sync with its own derived numbers.
 */
export interface PersistedLeaderboardEntryV1 {
    version: 1
    userId: string
    validRounds: number
    lastKnownDisplayName?: string
}

export const LEADERBOARD_SCHEMA_VERSION = 1

/** One Storage key per player - deliberately never a single object holding every player, which would force a read-modify-write of the whole leaderboard for every round, for every player, with worsening concurrency as the player count grows. */
export const LEADERBOARD_KEY_PREFIX = 'socialQuestLeaderboardV1:'

export function leaderboardKeyFor(normalizedUserId: string): string {
    return `${LEADERBOARD_KEY_PREFIX}${normalizedUserId}`
}

function isFiniteNonNegativeInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

/**
 * Defensively validates a value loaded from scene-scoped Storage - same
 * discipline as sanitizeSocialPointsProfile in persistenceSchema.ts, but
 * returns null (not a safe default) on anything malformed: an invalid
 * leaderboard entry should be skipped by its caller during hydration, never
 * silently replaced with a fabricated zero entry that could shadow or
 * conflict with a real player's own key.
 */
export function sanitizeLeaderboardEntry(raw: unknown): PersistedLeaderboardEntryV1 | null {
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    if (value.version !== LEADERBOARD_SCHEMA_VERSION) return null
    if (typeof value.userId !== 'string' || value.userId.trim().length === 0) return null
    if (!isFiniteNonNegativeInt(value.validRounds)) return null

    const entry: PersistedLeaderboardEntryV1 = {
        version: LEADERBOARD_SCHEMA_VERSION,
        userId: value.userId,
        validRounds: value.validRounds
    }
    if (typeof value.lastKnownDisplayName === 'string') {
        const trimmed = value.lastKnownDisplayName.trim()
        if (trimmed.length > 0) entry.lastKnownDisplayName = trimmed
    }
    return entry
}
