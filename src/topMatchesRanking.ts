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
 * Builds the ranked ALL TIME Top Matches list from raw persisted entries.
 * Excludes any entry whose affinity can't be computed (getCompatibility
 * returns null, i.e. sharedValidAnswers === 0) - not expected to occur in
 * practice since an entry is only ever created from a confirmed round, but
 * this is the same defensive stance getFriendshipLevel takes for an
 * analogous unreachable case.
 *
 * Deliberately does NOT filter by a minimum sharedValidAnswers yet - that
 * threshold (which is also what would exclude a 1/1=100% pair) is not fixed
 * yet, per product decision. This ranks every pair it's given; applying a
 * minimum is a caller-side, one-line filter on the result once that value is
 * decided - it does not require any change here.
 */
export function buildRankedTopMatches(entries: PersistedTopMatchEntryV1[]): TopMatchRankedEntry[] {
    const ranked: RankableTopMatch[] = []
    for (const entry of entries) {
        const affinity = getCompatibility(entry.sameAnswers, entry.differentAnswers)
        if (affinity === null) continue

        ranked.push({
            pairKey: entry.pairKey,
            userA: entry.userA,
            userB: entry.userB,
            displayNameA: toDisplayName(entry.displayNameA),
            displayNameB: toDisplayName(entry.displayNameB),
            sharedValidAnswers: getSharedValidAnswers(entry.sameAnswers, entry.differentAnswers),
            affinity
        })
    }

    return ranked.sort(compareRankedEntries).map((entry, index) => ({ rank: index + 1, ...entry }))
}

/**
 * Top `limit` pairs, ALL TIME. Returns status:'hydrating' with an empty top
 * and totalPairs:0 whenever the global index isn't confirmed fully loaded yet
 * - same hydration-safety contract as leaderboardRanking.ts's
 * getTopLeaderboardEntries: a partial cache is never presented as if it were
 * the final ranking.
 */
export function getTopMatches(limit: number): TopMatchesSnapshot {
    if (!isTopMatchesFullyLoaded()) {
        return { status: 'hydrating', totalPairs: 0, top: [] }
    }

    const ranked = buildRankedTopMatches(getTopMatchesCacheSnapshot())
    return { status: 'ready', totalPairs: ranked.length, top: ranked.slice(0, clampTopN(limit)) }
}
