import { engine, Entity, Schemas } from '@dcl/sdk/ecs'
import { syncEntity } from '@dcl/sdk/network'

/** Sentinel questionIndex while no round is active. */
export const NO_QUESTION = -1
/** Sentinel coordinatorId while no coordinator has been elected. */
export const NO_COORDINATOR = ''

/**
 * Fixed network id for the single global RoundState entity. Checked every existing
 * syncEntity() call in this project first (networkPlayerAnswer.ts, networkPlayerSession.ts):
 * neither passes an explicit entityEnumId - both are per-client dynamic entities that get an
 * auto-assigned network identity from the writer's own profile instead. So there is no
 * existing fixed-id usage to collide with. 1000 is used to stay clearly clear of the low
 * numbers (1-100) used in the SDK's own documented fixed-entity examples, in case any future
 * fixed-id entity in this project follows that convention.
 */
const ROUND_STATE_ENTITY_ENUM_ID = 1000

export enum SharedPhase {
    WAITING = 0,
    ANSWERING = 1,
    RESULT = 2
}

export interface RoundStateValue {
    roundId: number
    phase: SharedPhase
    questionIndex: number
    /** Authoritative countdown, written only by the coordinator - followers only display it. */
    secondsLeft: number
    /** Non-spectating player count snapshotted when the current round started. */
    participantCount: number
    /** userId of the client currently responsible for advancing RoundState. */
    coordinatorId: string
}

const RoundState = engine.defineComponent('social-quest::RoundState', {
    roundId: Schemas.Int,
    phase: Schemas.Int,
    questionIndex: Schemas.Int,
    secondsLeft: Schemas.Int,
    participantCount: Schemas.Int,
    coordinatorId: Schemas.String
})

const INITIAL_STATE: RoundStateValue = {
    roundId: 0,
    phase: SharedPhase.WAITING,
    questionIndex: NO_QUESTION,
    secondsLeft: 0,
    participantCount: 0,
    coordinatorId: NO_COORDINATOR
}

/** The single dedicated RoundState entity, with a fixed network identity - the same entity on every client. */
let roundStateEntity: Entity | null = null

/**
 * Shares round state across every client via CRDT sync (no server, no host) on a
 * dedicated entity with a fixed entityEnumId.
 *
 * Deliberately NOT engine.RootEntity: live two-client testing confirmed that a peer's
 * ongoing writes to RootEntity's RoundState never propagated to an already-connected,
 * purely-reading follower client (its own local writes always applied instantly, but
 * remote updates to that reserved/static entity did not arrive). A dedicated entity
 * created via engine.addEntity(), synced with an explicit entityEnumId so every client
 * maps it to the same network identity, is the SDK's documented pattern for exactly
 * this: create the entity, create its component with an initial value, THEN syncEntity.
 */
export function startRoundStateSync(): void {
    if (roundStateEntity !== null) return
    roundStateEntity = engine.addEntity()
    RoundState.create(roundStateEntity, INITIAL_STATE)
    syncEntity(roundStateEntity, [RoundState.componentId], ROUND_STATE_ENTITY_ENUM_ID)
}

export function getRoundState(): RoundStateValue {
    if (roundStateEntity === null) return INITIAL_STATE
    const value = RoundState.getOrNull(roundStateEntity)
    if (!value) return INITIAL_STATE
    return {
        roundId: value.roundId,
        phase: value.phase as SharedPhase,
        questionIndex: value.questionIndex,
        secondsLeft: value.secondsLeft,
        participantCount: value.participantCount,
        coordinatorId: value.coordinatorId
    }
}

export function writeRoundState(next: RoundStateValue): void {
    if (roundStateEntity === null) return
    RoundState.createOrReplace(roundStateEntity, next)
}
