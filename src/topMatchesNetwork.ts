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

/** The most recently received response, or null before any has arrived this session - same single-slot pattern as leaderboardNetwork.ts's latestLeaderboardResponse. Deliberately ONE slot for both scopes (not one per scope): leaderboardUi.tsx is what decides whether this response is still relevant to what's currently showing (see its own doc comment on why a scope/page mismatch there means "still loading", never "show it anyway"). */
let latestTopMatchesResponse: TopMatchesResponse | null = null

export function initTopMatchesNetworkClient(): void {
    topMatchesRoom.onMessage('topMatchesResponse', (data) => {
        if (data.status !== 'ready' && data.status !== 'hydrating') {
            console.error(`[TopMatches][CLIENT] topMatchesResponse had an unexpected status '${data.status}' - ignoring, latestTopMatchesResponse unchanged`)
            return
        }

        let rows: TopMatchRankedEntry[]
        try {
            rows = JSON.parse(data.rowsJson) as TopMatchRankedEntry[]
        } catch (err) {
            console.error(`[TopMatches][CLIENT] Failed to parse topMatchesResponse: ${err instanceof Error ? err.message : String(err)}`)
            return
        }

        // Out-of-range-page correction (the ranking shrank while a deeper page
        // was requested) is handled entirely by leaderboardUi.tsx, the one
        // place that also owns "which page does the UI currently want" - see
        // its own doc comment on TopMatchesSection. This layer only stores
        // whatever the server sent, unmodified.
        latestTopMatchesResponse = {
            scope: normalizeScope(data.scope),
            status: data.status,
            page: data.page,
            pageSize: data.pageSize,
            totalPairs: data.totalPairs,
            rows
        }
    })
}

/** Explicit request only - never on a tick/timer. `page` is always 0-based. */
export function requestTopMatches(scope: TopMatchesScope, page: number): void {
    topMatchesRoom.send('requestTopMatches', { scope, page, pageSize: TOP_MATCHES_PAGE_SIZE })
}

export function getLatestTopMatchesResponse(): TopMatchesResponse | null {
    return latestTopMatchesResponse
}
