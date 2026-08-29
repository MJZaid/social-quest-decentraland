import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

/**
 * Messages for the leaderboard read API only (Phase 2B-2) - a separate
 * channel from persistenceMessages.ts, same reasoning: distinct domain,
 * distinct room. The response's complex/variable-length payload (top N
 * entries + the caller's own entry) travels as a JSON string, same proven
 * approach persistenceMessages.ts already uses for profileResponse's
 * dataJson - Schemas.Map can't express a variable-length array of objects
 * any more cleanly than it can express an arbitrary-keyed record.
 *
 * `limit` is a required Int on the wire (Schemas.Map has no concept of an
 * optional field the way a TS interface does) - the client-side
 * requestLeaderboard() helper is what makes it feel optional, defaulting it
 * before ever constructing this payload. See leaderboardNetwork.ts.
 */
const LeaderboardMessages = {
    requestLeaderboard: Schemas.Map({
        limit: Schemas.Int
    }),
    leaderboardResponse: Schemas.Map({
        status: Schemas.String,
        totalPlayers: Schemas.Int,
        /** JSON-encoded `{ top: LeaderboardRankedEntry[], me: LeaderboardRankedEntry | null }` - see leaderboardNetwork.ts. */
        dataJson: Schemas.String
    })
}

export const leaderboardRoom = registerMessages(LeaderboardMessages)
