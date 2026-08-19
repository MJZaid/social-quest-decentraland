import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

/**
 * Messages for the persistence side-channel only - entirely separate from the
 * gameplay CRDT state (networkRoundState.ts, networkPlayerAnswer.ts,
 * networkPlayerSession.ts), which stays untouched. Complex/dynamic payloads
 * (the profile, the per-round deltas) travel as JSON strings rather than nested
 * Schemas.Map shapes, since Schemas can't express a Record<string, ...> with
 * arbitrary userId keys - the same approach proven in the auth-server prototype.
 */
const PersistenceMessages = {
    requestProfile: Schemas.Map({}),
    profileResponse: Schemas.Map({
        found: Schemas.Boolean,
        dataJson: Schemas.String,
        error: Schemas.String
    }),
    reportRound: Schemas.Map({
        roundId: Schemas.Int,
        deltasJson: Schemas.String
    }),
    reportRoundAck: Schemas.Map({
        ok: Schemas.Boolean,
        error: Schemas.String
    })
}

export const persistenceRoom = registerMessages(PersistenceMessages)
