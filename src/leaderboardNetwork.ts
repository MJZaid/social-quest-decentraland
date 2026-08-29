import { normalizeUserId } from './persistenceSchema'
import { getLeaderboardCacheSnapshot, isLeaderboardFullyLoaded } from './leaderboardManager'
import { buildRankedLeaderboardSnapshot, clampTopN, LeaderboardRankedEntry } from './leaderboardRanking'
import { leaderboardRoom } from './leaderboardMessages'

// -----------------------------------------------------------------------
// LEADERBOARD NETWORK (Phase 2B-2) - the server↔client plumbing for the
// leaderboard read API. Purely a transport/trust layer: all the actual
// ranking logic lives in leaderboardRanking.ts (pure, already tested) and
// all the cache/hydration state lives in leaderboardManager.ts. This file
// never touches Storage and never mutates either of those - it only reads
// their already-exposed read-only APIs and shapes the result into a wire
// message.
// -----------------------------------------------------------------------

export interface LeaderboardResponse {
    status: 'ready' | 'hydrating'
    totalPlayers: number
    top: LeaderboardRankedEntry[]
    me: LeaderboardRankedEntry | null
}

/** What requestLeaderboard() sends when the caller doesn't specify a limit - a transport default, not a UI concern (no panel exists yet to have an opinion about page size). */
const DEFAULT_REQUESTED_TOP_N = 10

// ---------------------------------------------------------------------------
// SERVER SIDE
// ---------------------------------------------------------------------------

/**
 * Builds the full response for one request: exactly ONE
 * buildRankedLeaderboardSnapshot() call (one sort) backs both the Top N
 * slice and the caller's own position - never two separate ranking builds
 * for the same request. `callerUserId` must be the REAL sender identity
 * (context.from from the message handler, same trust boundary
 * persistenceManager.ts's requestProfile handler already relies on) - never
 * anything read from the request payload, which carries no userId field at
 * all for exactly this reason.
 */
function buildLeaderboardResponse(limit: number, callerUserId: string): LeaderboardResponse {
    if (!isLeaderboardFullyLoaded()) {
        return { status: 'hydrating', totalPlayers: 0, top: [], me: null }
    }

    const ranked = buildRankedLeaderboardSnapshot(getLeaderboardCacheSnapshot())
    const top = ranked.slice(0, clampTopN(limit))
    const normalizedCaller = normalizeUserId(callerUserId)
    const me = ranked.find((entry) => entry.userId === normalizedCaller) ?? null

    return { status: 'ready', totalPlayers: ranked.length, top, me }
}

export function initLeaderboardNetworkServer(): void {
    leaderboardRoom.onMessage('requestLeaderboard', (data, context) => {
        if (!context) {
            console.log('[Leaderboard][SERVER] requestLeaderboard received with no context - dropping')
            return
        }

        const response = buildLeaderboardResponse(data.limit, context.from)
        leaderboardRoom.send(
            'leaderboardResponse',
            {
                status: response.status,
                totalPlayers: response.totalPlayers,
                dataJson: JSON.stringify({ top: response.top, me: response.me })
            },
            { to: [context.from] } // only ever back to the requester - never broadcast
        )
    })
}

// ---------------------------------------------------------------------------
// CLIENT SIDE
// ---------------------------------------------------------------------------

/** The most recently received response, or null before any has arrived this session. No polling, no auto-refresh - only ever set by an explicit requestLeaderboard() call's response. */
let latestLeaderboardResponse: LeaderboardResponse | null = null

export function initLeaderboardNetworkClient(): void {
    leaderboardRoom.onMessage('leaderboardResponse', (data) => {
        if (data.status !== 'ready' && data.status !== 'hydrating') {
            console.error(`[Leaderboard][CLIENT] leaderboardResponse had an unexpected status '${data.status}' - ignoring, latestLeaderboardResponse unchanged`)
            return
        }

        try {
            const parsed = JSON.parse(data.dataJson) as { top: LeaderboardRankedEntry[]; me: LeaderboardRankedEntry | null }
            latestLeaderboardResponse = {
                status: data.status,
                totalPlayers: data.totalPlayers,
                top: parsed.top,
                me: parsed.me
            }
        } catch (err) {
            console.error(`[Leaderboard][CLIENT] Failed to parse leaderboardResponse: ${err instanceof Error ? err.message : String(err)}`)
        }
    })
}

/** Explicit request only - never called automatically/on a tick. `limit` defaults here (transport-level default), not in the wire schema, which has no concept of an optional field. */
export function requestLeaderboard(limit: number = DEFAULT_REQUESTED_TOP_N): void {
    leaderboardRoom.send('requestLeaderboard', { limit })
}

export function getLatestLeaderboardResponse(): LeaderboardResponse | null {
    return latestLeaderboardResponse
}
