import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

/**
 * Messages for the persistence side-channel only - entirely separate from the
 * gameplay CRDT state (networkRoundState.ts, networkPlayerAnswer.ts,
 * networkPlayerSession.ts), which stays untouched. The complex/dynamic payload
 * (the profile) travels as a JSON string rather than a nested Schemas.Map shape,
 * since Schemas can't express a Record<string, ...> with arbitrary userId keys -
 * the same approach proven in the auth-server prototype.
 *
 * Only one message pair exists: the client requests its own profile once, on
 * join. Round completion is detected and validated entirely server-side, by
 * reading the same synced RoundState/PlayerAnswer/PlayerSession the client
 * already relies on - the client never reports round outcomes, so there is
 * nothing here for the server to have to trust or distrust.
 */
const PersistenceMessages = {
    requestProfile: Schemas.Map({}),
    profileResponse: Schemas.Map({
        found: Schemas.Boolean,
        dataJson: Schemas.String,
        error: Schemas.String,
        /** Lets the client reconstruct the same event-id format the server uses for dedup, to resolve the hydration/local-progress race - see persistenceManager.ts. Identifies a server process, nothing sensitive. */
        serverSessionId: Schemas.String
    })
}

export const persistenceRoom = registerMessages(PersistenceMessages)
