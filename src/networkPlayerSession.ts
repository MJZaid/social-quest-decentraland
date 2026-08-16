import { engine, Entity, Schemas } from '@dcl/sdk/ecs'
import { syncEntity, myProfile } from '@dcl/sdk/network'

export interface PlayerSessionValue {
    userId: string
    joined: boolean
    /** This player is only ACTIVE for round R when joined && eligibleFromRoundId <= R. */
    eligibleFromRoundId: number
}

const PlayerSession = engine.defineComponent('social-quest::PlayerSession', {
    userId: Schemas.String,
    joined: Schemas.Boolean,
    eligibleFromRoundId: Schemas.Int
})

/** This client's own dedicated session entity. Created once; never engine.PlayerEntity (same reasoning as PlayerAnswer). */
let sessionEntity: Entity | null = null

export function startPlayerSessionSync(): void {
    if (sessionEntity !== null) return
    sessionEntity = engine.addEntity()
    PlayerSession.create(sessionEntity, { userId: myProfile.userId, joined: false, eligibleFromRoundId: 0 })
    syncEntity(sessionEntity, [PlayerSession.componentId])
}

/** Publishes this client's own join state. Preserves eligibleFromRoundId when not explicitly given (e.g. on leave). */
export function setJoined(joined: boolean, eligibleFromRoundId?: number): void {
    if (sessionEntity === null) return
    const current = PlayerSession.getOrNull(sessionEntity)
    PlayerSession.createOrReplace(sessionEntity, {
        userId: myProfile.userId,
        joined,
        eligibleFromRoundId: eligibleFromRoundId ?? current?.eligibleFromRoundId ?? 0
    })
}

export function getOwnSession(): PlayerSessionValue | null {
    if (sessionEntity === null) return null
    const value = PlayerSession.getOrNull(sessionEntity)
    if (!value) return null
    return { userId: value.userId, joined: value.joined, eligibleFromRoundId: value.eligibleFromRoundId }
}

function getAllSessions(): PlayerSessionValue[] {
    const sessions: PlayerSessionValue[] = []
    for (const [, value] of engine.getEntitiesWith(PlayerSession)) {
        sessions.push({ userId: value.userId, joined: value.joined, eligibleFromRoundId: value.eligibleFromRoundId })
    }
    return sessions
}

export function getJoinedUserIds(): string[] {
    return getAllSessions()
        .filter((session) => session.joined)
        .map((session) => session.userId)
}

/** Players who are joined AND eligible for `roundId` - excludes players still pending for a future round. */
export function getActiveUserIds(roundId: number): string[] {
    return getAllSessions()
        .filter((session) => session.joined && session.eligibleFromRoundId <= roundId)
        .map((session) => session.userId)
}
