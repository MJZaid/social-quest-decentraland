import { getTopMatchesPage, TopMatchRankedEntry } from './topMatchesRanking'
import { getTopMatchesThisWeekPage } from './topMatchesWeeklyManager'
import { topMatchesRoom, TopMatchesScope, TOP_MATCHES_PAGE_SIZE } from './topMatchesMessages'

// -----------------------------------------------------------------------
// TOP MATCHES NETWORK - the server<->client plumbing for the Top Matches read
// API, same architectural role as leaderboardNetwork.ts for Social Points:
// purely a transport/trust layer. All ranking logic stays in
// topMatchesRanking.ts/topMatchesWeeklyManager.ts (unchanged, unduplicated);
// this file never touches Storage and never mutates either manager's cache -
// it only calls their already-exposed read-only getTopMatches/
// getTopMatchesThisWeek and shapes/slices the result into a wire message.
// -----------------------------------------------------------------------

export interface TopMatchesResponse {
    scope: TopMatchesScope
    status: 'ready' | 'hydrating'
    page: number
    pageSize: number
    /** Total eligible pairs for this scope, already threshold-filtered by the manager - see topMatchesMessages.ts's own doc comment on the wire field this is read from. */
    totalPairs: number
    /** Only this page's rows - already sliced from the manager's own ranked output, never re-ranked here. */
    rows: TopMatchRankedEntry[]
}

function normalizeScope(rawScope: string): TopMatchesScope {
    return rawScope === 'allTime' ? 'allTime' : 'thisWeek' // never trust the wire value blindly - anything unrecognized falls back to the smaller/safer default rather than throwing
}

// ---------------------------------------------------------------------------
// SERVER SIDE
// ---------------------------------------------------------------------------

/**
 * Builds one page's response for one scope - exactly ONE getTopMatchesPage()/
 * getTopMatchesThisWeekPage() call per request (never both, never twice), no
 * new ranking pass of its own. Uses the offset-based page functions, NOT
 * getTopMatches()/getTopMatchesThisWeek() - those are capped at MAX_TOP_N
 * (100) by clampTopN (right for a "top N" read, wrong for real pagination:
 * pair #101 onward would be permanently unreachable, while totalPairs/
 * totalPages would still claim more pages exist - a real edge case once a
 * scope has more than 100 eligible pairs). getTopMatchesPage/
 * getTopMatchesThisWeekPage slice the FULL ranked array instead, so any
 * offset is reachable and every returned entry keeps its correct GLOBAL rank
 * - see topMatchesRanking.ts's own doc comment on that pairing.
 *
 * `totalPairs` always comes from the snapshot's own `totalPairs` (the FULL
 * eligible count after that scope's threshold filter), never from
 * `rows.length` - so the client can compute a correct totalPages even from a
 * short/empty page.
 */
function buildTopMatchesResponse(scope: TopMatchesScope, rawPage: number, rawPageSize: number): TopMatchesResponse {
    const page = Number.isFinite(rawPage) && rawPage >= 0 ? Math.floor(rawPage) : 0
    const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.floor(rawPageSize) : TOP_MATCHES_PAGE_SIZE
    const offset = page * pageSize

    const snapshot = scope === 'allTime' ? getTopMatchesPage(offset, pageSize) : getTopMatchesThisWeekPage(offset, pageSize)

    if (snapshot.status === 'hydrating') {
        return { scope, status: 'hydrating', page, pageSize, totalPairs: 0, rows: [] }
    }

    return { scope, status: 'ready', page, pageSize, totalPairs: snapshot.totalPairs, rows: snapshot.top }
}

export function initTopMatchesNetworkServer(): void {
    topMatchesRoom.onMessage('requestTopMatches', (data, context) => {
        if (!context) {
            console.log('[TopMatches][SERVER] requestTopMatches received with no context - dropping')
            return
        }

        const scope = normalizeScope(data.scope)
        const response = buildTopMatchesResponse(scope, data.page, data.pageSize)

        topMatchesRoom.send(
            'topMatchesResponse',
            {
                scope: response.scope,
                status: response.status,
                page: response.page,
                pageSize: response.pageSize,
                totalPairs: response.totalPairs,
                rowsJson: JSON.stringify(response.rows)
            },
            { to: [context.from] } // only ever back to the requester - never broadcast
        )
    })
}

// ---------------------------------------------------------------------------
// CLIENT SIDE
// ---------------------------------------------------------------------------

/**
 * Confirmed responses, cached per (scope, page) - NOT a single "latest of
 * either scope/page" slot. This exists because this module now has TWO
 * independent, concurrent consumers: leaderboardUi.tsx's 2D panel (whatever
 * scope/page the player currently has open) and leaderboardDisplay3D.ts's
 * permanent sign (always thisWeek page 0 + allTime page 0, on its own timer,
 * regardless of what the 2D panel is showing). A single shared slot would
 * mean the sign's own periodic request for e.g. allTime page 0 could
 * overwrite what the 2D panel just fetched for allTime page 1 - the panel's
 * own scope/page match check (see leaderboardUi.tsx's TopMatchesSection)
 * would then never see ITS page's data again, since every future refresh
 * from the sign keeps clobbering that one shared slot with page 0. Keying by
 * (scope, page) instead means each consumer only ever reads and overwrites
 * its OWN cache entry - two different keys can never collide, and a
 * response for one is never visible to a caller asking for the other. Not
 * bounded/evicted: in practice this is at most 2 scopes x a small number of
 * distinct pages any client ever actually requests in a session, nowhere
 * near a real memory concern.
 */
const responseCache = new Map<string, TopMatchesResponse>()

function cacheKey(scope: TopMatchesScope, page: number): string {
    return `${scope}:${page}`
}

export function initTopMatchesNetworkClient(): void {
    topMatchesRoom.onMessage('topMatchesResponse', (data) => {
        if (data.status !== 'ready' && data.status !== 'hydrating') {
            console.error(`[TopMatches][CLIENT] topMatchesResponse had an unexpected status '${data.status}' - ignoring, cache unchanged`)
            return
        }

        let rows: TopMatchRankedEntry[]
        try {
            rows = JSON.parse(data.rowsJson) as TopMatchRankedEntry[]
        } catch (err) {
            console.error(`[TopMatches][CLIENT] Failed to parse topMatchesResponse: ${err instanceof Error ? err.message : String(err)}`)
            return
        }

        const scope = normalizeScope(data.scope)
        // Out-of-range-page correction (the ranking shrank while a deeper page
        // was requested) is handled entirely by leaderboardUi.tsx, the one
        // place that also owns "which page does the UI currently want" - see
        // its own doc comment on TopMatchesSection. This layer only stores
        // whatever the server sent, unmodified, under the (scope, page) it
        // actually reports - never under whatever page a caller originally
        // asked for, in case those ever disagreed.
        responseCache.set(cacheKey(scope, data.page), {
            scope,
            status: data.status,
            page: data.page,
            pageSize: data.pageSize,
            totalPairs: data.totalPairs,
            rows
        })
    })
}

/** Explicit request only - never on a tick/timer from this module itself (leaderboardDisplay3D.ts owns its own timer, same as leaderboardUi.tsx owns its own click-driven requests). `page` is always 0-based. */
export function requestTopMatches(scope: TopMatchesScope, page: number): void {
    topMatchesRoom.send('requestTopMatches', { scope, page, pageSize: TOP_MATCHES_PAGE_SIZE })
}

/** The last confirmed response for this exact (scope, page), or null if none has arrived yet this session - see responseCache's own doc comment for why this is keyed rather than a single shared slot. */
export function getTopMatchesResponse(scope: TopMatchesScope, page: number): TopMatchesResponse | null {
    return responseCache.get(cacheKey(scope, page)) ?? null
}
