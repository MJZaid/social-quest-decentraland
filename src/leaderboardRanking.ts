import { PersistedLeaderboardEntryV1 } from './leaderboardSchema'
import { getLeaderboardCacheSnapshot, isLeaderboardFullyLoaded } from './leaderboardManager'
import { getTotalSocialPoints, normalizeUserId } from './persistenceSchema'

// -----------------------------------------------------------------------
// LEADERBOARD RANKING (Social Points v2) - a pure, read-only derivation layer
// on top of the confirmed leaderboardEntries cache. No Storage access, no
// client messages, no mutation of anything - every export here is a plain
// function from the current cache snapshot to a freshly-built DTO.
// rank/socialPoints are NEVER persisted anywhere (same discipline as
// leaderboardSchema.ts/persistenceSchema.ts) - they exist only in the DTOs
// this file returns. socialPoints is the v2 total (validRounds +
// friendshipBonusPoints, getTotalSocialPoints) - the old tier-based
// getSocialPoints/questProgress are no longer used by this flow.
// -----------------------------------------------------------------------

/** Presentation-only fallback for a player whose canonical entry has no observed name yet - never written back to Storage or to the canonical entry, only ever appears inside a DTO built here. */
const DISPLAY_NAME_FALLBACK = 'Questmate'

const MIN_TOP_N = 1
const MAX_TOP_N = 100

export interface LeaderboardRankedEntry {
    rank: number
    userId: string
    displayName: string
    validRounds: number
    socialPoints: number
}

export interface LeaderboardSnapshot {
    status: 'ready' | 'hydrating'
    totalPlayers: number
    top: LeaderboardRankedEntry[]
}

export interface PlayerLeaderboardPosition {
    status: 'ready' | 'hydrating'
    found: boolean
    totalPlayers: number
    entry?: LeaderboardRankedEntry
}

function toDisplayName(entry: PersistedLeaderboardEntryV1): string {
    const trimmed = entry.lastKnownDisplayName?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : DISPLAY_NAME_FALLBACK
}

/** A ranked entry before its final position is known - rank is only ever assigned once, after sorting (see buildRankedLeaderboardSnapshot). Mirrors topMatchesRanking.ts's own RankableTopMatch shape. */
type RankableLeaderboardEntry = Omit<LeaderboardRankedEntry, 'rank'>

/** Canonical order (product-approved): socialPoints DESC (the v2 total - validRounds + friendshipBonusPoints), then validRounds DESC as a tiebreak between two players with the same total (e.g. one earned theirs mostly from rounds, another mostly from Friendship bonuses), then userId ASC as the final deterministic tiebreak. */
function compareRankedEntries(a: RankableLeaderboardEntry, b: RankableLeaderboardEntry): number {
    if (b.socialPoints !== a.socialPoints) return b.socialPoints - a.socialPoints
    if (b.validRounds !== a.validRounds) return b.validRounds - a.validRounds
    if (a.userId < b.userId) return -1
    if (a.userId > b.userId) return 1
    return 0
}

/**
 * Sorts the given entries exactly once and derives rank (ordinal, 1-based, no
 * ties/dense-ranking) plus socialPoints (getTotalSocialPoints - the v2 total,
 * never the old tier formula) for each. Pure: `entries` is never mutated, and
 * every returned object is a brand-new DTO - the canonical
 * PersistedLeaderboardEntryV1 objects are never handed out or written into.
 *
 * Exported so a single logical query needing BOTH a Top N slice and one
 * player's position can call this exactly once and derive both from the same
 * ranked array - see getTopLeaderboardEntries/getPlayerLeaderboardPosition
 * below for the single-purpose shape this same building block already backs.
 */
export function buildRankedLeaderboardSnapshot(entries: PersistedLeaderboardEntryV1[]): LeaderboardRankedEntry[] {
    const rankable: RankableLeaderboardEntry[] = entries.map((entry) => ({
        userId: entry.userId,
        displayName: toDisplayName(entry),
        validRounds: entry.validRounds,
        socialPoints: getTotalSocialPoints(entry.validRounds, entry.friendshipBonusPoints)
    }))

    return rankable.sort(compareRankedEntries).map((entry, index) => ({ rank: index + 1, ...entry }))
}

/**
 * Deterministic limit sanitization for Top N, exported so a future combined
 * caller (see buildRankedLeaderboardSnapshot's doc comment) can slice a
 * shared ranked array with the exact same rule getTopLeaderboardEntries
 * uses, rather than reimplementing it.
 *
 * NaN is the only value that needs an explicit guard - it poisons every
 * Math.min/Math.max comparison (NaN compared to anything is always false),
 * so without this check it would flow straight through to a NaN result.
 * Every other value, including +/-Infinity, is well-behaved under
 * floor-then-clamp: floor(2.9)=2 (truncates toward the requested count,
 * never rounds up past what was asked for), floor(Infinity)=Infinity which
 * Math.min(MAX_TOP_N, ...) then saturates down to MAX_TOP_N, and
 * floor(-Infinity)=-Infinity which Math.max(MIN_TOP_N, ...) saturates up to
 * MIN_TOP_N - the same natural clamp that 0 and -5 already go through.
 */
export function clampTopN(limit: number): number {
    if (Number.isNaN(limit)) return MIN_TOP_N
    return Math.min(MAX_TOP_N, Math.max(MIN_TOP_N, Math.floor(limit)))
}

/**
 * Top `limit` players, ALL TIME. Returns status:'hydrating' with an empty
 * top and totalPlayers:0 whenever the global index isn't confirmed fully
 * loaded yet (isLeaderboardFullyLoaded() false) - a partial cache is never
 * presented as if it were the final ranking, per Phase 2B-1's hydration
 * safety requirement.
 */
export function getTopLeaderboardEntries(limit: number): LeaderboardSnapshot {
    if (!isLeaderboardFullyLoaded()) {
        return { status: 'hydrating', totalPlayers: 0, top: [] }
    }

    const ranked = buildRankedLeaderboardSnapshot(getLeaderboardCacheSnapshot())
    return { status: 'ready', totalPlayers: ranked.length, top: ranked.slice(0, clampTopN(limit)) }
}

/**
 * One player's position in the ALL TIME ranking. Same hydration-safety
 * contract as getTopLeaderboardEntries: status:'hydrating' (found:false,
 * totalPlayers:0) until the index is confirmed fully loaded - never a
 * guess derived from a partial cache.
 */
export function getPlayerLeaderboardPosition(userId: string): PlayerLeaderboardPosition {
    if (!isLeaderboardFullyLoaded()) {
        return { status: 'hydrating', found: false, totalPlayers: 0 }
    }

    const ranked = buildRankedLeaderboardSnapshot(getLeaderboardCacheSnapshot())
    const entry = ranked.find((candidate) => candidate.userId === normalizeUserId(userId))
    if (!entry) {
        return { status: 'ready', found: false, totalPlayers: ranked.length }
    }
    return { status: 'ready', found: true, totalPlayers: ranked.length, entry }
}
