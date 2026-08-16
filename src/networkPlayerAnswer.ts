import { engine, Entity, Schemas } from '@dcl/sdk/ecs'
import { syncEntity, myProfile } from '@dcl/sdk/network'
import { getPlayer } from '@dcl/sdk/players'

export enum AnswerOption {
    A = 0,
    B = 1,
    NO_ANSWER = 2
}

export interface PlayerAnswerValue {
    roundId: number
    option: AnswerOption
    userId: string
}

const PlayerAnswer = engine.defineComponent('social-quest::PlayerAnswer', {
    roundId: Schemas.Int,
    option: Schemas.Int,
    userId: Schemas.String
})

/** Sentinel roundId for the placeholder value written before any real answer exists. */
const NO_ROUND = 0

/** This client's own dedicated answer entity. Created once; never engine.PlayerEntity. */
let answerEntity: Entity | null = null

/**
 * Creates this client's own dedicated answer entity (once) and registers it for sync.
 *
 * Deliberately NOT engine.PlayerEntity: that reserved slot means "myself" identically
 * on every client's own engine, so two peers writing to "their own" PlayerEntity both
 * land on the same conceptual slot for every observer and stomp each other. A freshly
 * engine.addEntity()-created entity, synced without an explicit entityEnumId, is the
 * supported "one independent entity per peer" pattern (same shape as the SDK's
 * documented player-created/dynamic entity example, e.g. a player-spawned projectile):
 * create the entity, create its component with an initial value, THEN call syncEntity.
 */
export function startPlayerAnswerSync(): void {
    if (answerEntity !== null) return
    answerEntity = engine.addEntity()
    PlayerAnswer.create(answerEntity, { roundId: NO_ROUND, option: AnswerOption.NO_ANSWER, userId: myProfile.userId })
    syncEntity(answerEntity, [PlayerAnswer.componentId])
}

/**
 * Publishes this client's own answer for `roundId` by updating its dedicated answer
 * entity in place - the same entity is reused every round, never recreated.
 */
export function publishPlayerAnswer(roundId: number, option: AnswerOption): void {
    if (answerEntity === null) return
    PlayerAnswer.createOrReplace(answerEntity, { roundId, option, userId: myProfile.userId })
}

/** Collects every currently-known answer (local + remote) for a specific round. */
export function getAnswersForRound(roundId: number): PlayerAnswerValue[] {
    const results: PlayerAnswerValue[] = []
    for (const [, value] of engine.getEntitiesWith(PlayerAnswer)) {
        if (value.roundId === roundId) {
            results.push({ roundId: value.roundId, option: value.option as AnswerOption, userId: value.userId })
        }
    }
    return results
}

export function getDisplayName(userId: string): string {
    return getPlayer({ userId })?.name || 'Player'
}
