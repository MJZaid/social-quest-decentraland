import { PersistedTopMatchEntryV1 } from './topMatchesSchema'
import { getTopMatchesCacheSnapshot, isTopMatchesFullyLoaded } from './topMatchesManager'
import { getCompatibility, getSharedValidAnswers } from './compatibilityManager'

// -----------------------------------------------------------------------
// TOP MATCHES RANKING (backend only) - a pure, read-only derivation layer on
// top of topMatchesManager.ts's confirmed cache, mirroring
// leaderboardRanking.ts's own role exactly. No Storage access, no client
// messages, no mutation of anything. affinity/sharedValidAnswers are NEVER
// persisted (see topMatchesSchema.ts) - both are derived here, every call,
// via compatibilityManager.ts's existing pure functions, never a
// reimplementation of that formula.
// -----------------------------------------------------------------------

/** Presentation-only fallback for a pair member with no observed name yet - never written back to Storage, only ever appears inside a DTO built here. */
const DISPLAY_NAME_FALLBACK = 'Questmate'

const MIN_TOP_N = 1
const MAX_TOP_N = 100

/** ALL TIME's own minimum - a pair needs at least this many shared valid answers to appear in the ALL TIME ranking. Product decision, not derived from anything - see getTopMatches below, the only caller that applies it. */
const ALL_TIME_MIN_SHARED_ANSWERS = 20

export interface TopMatchRankedEntry {
    rank: number
    pairKey: string
    userA: string
    userB: string
    displayNameA: string
    displayNameB: string
    sharedValidAnswers: number
    affinity: number
}

export interface TopMatchesSnapshot {
    status: 'ready' | 'hydrating'
    totalPairs: number
    top: TopMatchRankedEntry[]
}

function toDisplayName(name: string | undefined): string {
    const trimmed = name?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : DISPLAY_NAME_FALLBACK
}

/** A ranked entry before its final position is known - rank is only ever assigned once, after sorting (see buildRankedTopMatches). */
type RankableTopMatch = Omit<TopMatchRankedEntry, 'rank'>

/** Canonical order: affinity DESC, sharedValidAnswers DESC (a real second axis today only when two pairs share the exact same percentage), pairKey ASC as a deterministic final tiebreak - mirrors leaderboardRanking.ts's own compareEntries shape exactly. */
function compareRankedEntries(a: RankableTopMatch, b: RankableTopMatch): number {
    if (b.affinity !== a.affinity) return b.affinity - a.affinity
    if (b.sharedValidAnswers !== a.sharedValidAnswers) return b.sharedValidAnswers - a.sharedValidAnswers
    if (a.pairKey < b.pairKey) return -1
    if (a.pairKey > b.pairKey) return 1
    return 0
}

/**
 * Deterministic limit sanitization for Top N - identical rule and reasoning
 * to leaderboardRanking.ts's clampTopN, duplicated rather than imported since
 * the two domains (players vs pairs) are kept deliberately independent (see
 * topMatchesSchema.ts's own file-level doc comment).
 */
export function clampTopN(limit: number): number {
    if (Number.isNaN(limit)) return MIN_TOP_N
    return Math.min(MAX_TOP_N, Math.max(MIN_TOP_N, Math.floor(limit)))
}

/**
 * Builds a ranked Top Matches list from raw persisted entries, shared by BOTH
 * ALL TIME and THIS WEEK (topMatchesWeeklyManager.ts's getTopMatchesThisWeek
 * passes PersistedTopMatchWeeklyEntryV1[] here directly - structurally
 * assignable, see that file's own doc comment). `minSharedAnswers` is
 * deliberately a required parameter, not a default baked in here: ALL TIME
 * and THIS WEEK have different product minimums (20 vs 5), and each caller
 * below states its own value explicitly rather than this shared function
 * silently picking one for both domains.
 *
 * Excludes any entry whose affinity can't be computed (getCompatibility
 * returns null, i.e. sharedValidAnswers === 0) - not expected to occur in
 * practice since an entry is only ever created from a confirmed round, but
 * this is the same defensive stance getFriendshipLevel takes for an
 * analogous unreachable case. Also excludes any entry below
 * `minSharedAnswers` - this is what keeps a 1/1=100% pair (or any pair below
 * the caller's own threshold) out of the ranking. Both checks happen BEFORE
 * sorting; the sort/tiebreak order itself (affinity DESC, sharedValidAnswers
 * DESC, pairKey ASC) is unchanged.
 */
export function buildRankedTopMatches(entries: PersistedTopMatchEntryV1[], minSharedAnswers: number): TopMatchRankedEntry[] {
    const ranked: RankableTopMatch[] = []
    for (const entry of entries) {
        const affinity = getCompatibility(entry.sameAnswers, entry.differentAnswers)
        if (affinity === null) continue

        const sharedValidAnswers = getSharedValidAnswers(entry.sameAnswers, entry.differentAnswers)
        if (sharedValidAnswers < minSharedAnswers) continue

        ranked.push({
            pairKey: entry.pairKey,
            userA: entry.userA,
            userB: entry.userB,
            displayNameA: toDisplayName(entry.displayNameA),
            displayNameB: toDisplayName(entry.displayNameB),
            sharedValidAnswers,
            affinity
        })
    }

    return ranked.sort(compareRankedEntries).map((entry, index) => ({ rank: index + 1, ...entry }))
}

/**
 * Top `limit` pairs, ALL TIME - applies ALL_TIME_MIN_SHARED_ANSWERS (20).
 * Returns status:'hydrating' with an empty top and totalPairs:0 whenever the
 * global index isn't confirmed fully loaded yet - same hydration-safety
 * contract as leaderboardRanking.ts's getTopLeaderboardEntries: a partial
 * cache is never presented as if it were the final ranking.
 */
export function getTopMatches(limit: number): TopMatchesSnapshot {
    if (!isTopMatchesFullyLoaded()) {
        return { status: 'hydrating', totalPairs: 0, top: [] }
    }

    const ranked = buildRankedTopMatches(getTopMatchesCacheSnapshot(), ALL_TIME_MIN_SHARED_ANSWERS)
    return { status: 'ready', totalPairs: ranked.length, top: ranked.slice(0, clampTopN(limit)) }
}

/**
 * One page of the ALL TIME ranking starting at `offset` - the pagination-safe
 * counterpart to getTopMatches above. getTopMatches is capped at MAX_TOP_N
 * (100) by clampTopN, which is exactly right for a "top N" read but makes
 * pair #101 onward permanently unreachable through it - not acceptable once
 * a caller needs real page-by-page navigation over however many eligible
 * pairs actually exist (see topMatchesNetwork.ts, the caller this was added
 * for). This calls buildRankedTopMatches exactly once, the SAME way
 * getTopMatches does - no second ranking pass, same threshold
 * (ALL_TIME_MIN_SHARED_ANSWERS), same sort order - and slices the FULL
 * ranked array at `offset`, with no upper bound on how far `offset` can
 * reach. Because buildRankedTopMatches assigns `rank` once, across the
 * entire sorted array, before any slicing happens (see its own doc comment),
 * every entry returned here still carries its correct GLOBAL rank (#101,
 * #142, ...) - never renumbered relative to the page. `offset`/`pageSize`
 * are trusted to already be sane non-negative integers - see
 * topMatchesNetwork.ts's own sanitization, the only caller.
 */
export function getTopMatchesPage(offset: number, pageSize: number): TopMatchesSnapshot {
    if (!isTopMatchesFullyLoaded()) {
        return { status: 'hydrating', totalPairs: 0, top: [] }
    }

    const ranked = buildRankedTopMatches(getTopMatchesCacheSnapshot(), ALL_TIME_MIN_SHARED_ANSWERS)
    return { status: 'ready', totalPairs: ranked.length, top: ranked.slice(offset, offset + pageSize) }
}
