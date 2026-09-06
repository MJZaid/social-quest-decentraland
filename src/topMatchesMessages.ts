import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

// -----------------------------------------------------------------------
// TOP MATCHES MESSAGES - the read API's wire contract, own channel/room, same
// reasoning as leaderboardMessages.ts's own doc comment (distinct domain,
// distinct room). ONE message pair covers BOTH THIS WEEK and ALL TIME -
// `scope` on the wire is what tells them apart, rather than two separate
// request/response pairs, since the shape is otherwise identical between the
// two domains (see topMatchesNetwork.ts, which picks
// getTopMatchesThisWeekPage() vs getTopMatchesPage() based on this same
// field).
//
// The response's rows travel as a JSON string (rowsJson), same proven
// approach leaderboardMessages.ts already uses for leaderboardResponse's
// dataJson - Schemas.Map can't express a variable-length array of objects.
// -----------------------------------------------------------------------

/** Which Top Matches ranking a request/response is about - reused verbatim by topMatchesNetwork.ts and leaderboardUi.tsx rather than each redefining their own copy of this union. */
export type TopMatchesScope = 'thisWeek' | 'allTime'

/** Product-approved page size - 5 pairs per page, same constant reused by topMatchesNetwork.ts's default request and leaderboardUi.tsx's pagination. */
export const TOP_MATCHES_PAGE_SIZE = 5

const TopMatchesMessages = {
    requestTopMatches: Schemas.Map({
        /** 'thisWeek' | 'allTime' (TopMatchesScope) - a plain Int/String on the wire since Schemas has no string-literal-union type; topMatchesNetwork.ts is the only place that ever treats an unrecognized value defensively (falls back to 'thisWeek'). */
        scope: Schemas.String,
        /** 0-based page index - never negative, never assumed in-range by the server; see topMatchesNetwork.ts's buildTopMatchesResponse for how an out-of-range page is handled without a second ranking pass. */
        page: Schemas.Int,
        /** Always TOP_MATCHES_PAGE_SIZE from the client today - carried on the wire (not hardcoded server-side) so a future product change to page size doesn't require a protocol version bump. */
        pageSize: Schemas.Int
    }),
    topMatchesResponse: Schemas.Map({
        scope: Schemas.String,
        status: Schemas.String,
        page: Schemas.Int,
        pageSize: Schemas.Int,
        /** Total eligible pairs for this scope AFTER its own threshold filter (THIS_WEEK_MIN_SHARED_ANSWERS / ALL_TIME_MIN_SHARED_ANSWERS, both already applied inside topMatchesRanking.ts/topMatchesWeeklyManager.ts) - never just this page's row count. Source for totalPages = max(1, ceil(totalPairs / pageSize)), computed by the client, never persisted. */
        totalPairs: Schemas.Int,
        /** JSON-encoded TopMatchRankedEntry[] - only this one page's rows, already sliced server-side from the manager's own ranked output (see topMatchesNetwork.ts). */
        rowsJson: Schemas.String
    })
}

export const topMatchesRoom = registerMessages(TopMatchesMessages)
