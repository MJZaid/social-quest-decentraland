import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

/**
 * Messages for the persistence side-channel only - entirely separate from the
 * gameplay CRDT state (networkRoundState.ts, networkPlayerAnswer.ts,
 * networkPlayerSession.ts), which stays untouched. Any complex/dynamic
 * payload (a profile, a list of ids) travels as a JSON string rather than a
 * nested Schemas.Map/Array shape - same approach already proven here
 * (Connections' own dataJson) and in topMatchesMessages.ts's rowsJson, kept
 * consistent rather than introducing Schemas.Array as a one-off exception.
 *
 * Two message pairs/directions exist:
 * - requestProfile / profileResponse: the client requests its own profile
 *   once, on join. Round completion is detected and validated entirely
 *   server-side, by reading the same synced RoundState/PlayerAnswer/
 *   PlayerSession the client already relies on - the client never reports
 *   round outcomes, so there is nothing here for the server to have to trust
 *   or distrust for Connections/Social Points.
 * - markConnectionsSeen: client -> server only, fire-and-forget (no response
 *   message needed) - the one exception to "client never tells the server
 *   what happened": here the client is only ever reporting which of ITS OWN
 *   already-server-confirmed unseen ids it just revealed to itself inside
 *   Social Agenda, purely UI/notification metadata, never a gameplay claim.
 *   Identity is derived server-side from the message context (context.from),
 *   never a client-sent field - see persistenceManager.ts's handler.
 */
const PersistenceMessages = {
    requestProfile: Schemas.Map({}),
    profileResponse: Schemas.Map({
        found: Schemas.Boolean,
        dataJson: Schemas.String,
        error: Schemas.String,
        /** Lets the client reconstruct the same event-id format the server uses for dedup, to resolve the hydration/local-progress race - see persistenceManager.ts. Identifies a server process, nothing sensitive. */
        serverSessionId: Schemas.String,
        /** JSON-encoded string[] of normalized otherUserIds not yet revealed inside Social Agenda (socialQuestNotificationsV1 - see persistenceSchema.ts). Always present, even when empty ('[]') - that's what lets the client tell "hydrated with zero unseen" apart from "hydration hasn't arrived yet" (see socialNotificationsManager.ts's isNotificationsHydrated()). */
        unseenConnectionIdsJson: Schemas.String
    }),
    markConnectionsSeen: Schemas.Map({
        /** JSON-encoded string[] of the exact otherUserIds this Social Agenda reveal is marking seen - validated/sanitized server-side (persistenceSchema.ts's sanitizeConnectionIdList) before ever touching Storage. Never a clear-all signal - the server only ever removes exactly these ids. */
        connectionIdsJson: Schemas.String
    })
}

export const persistenceRoom = registerMessages(PersistenceMessages)
