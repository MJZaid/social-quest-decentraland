import { AvatarBase, engine, PlayerIdentityData } from '@dcl/sdk/ecs'

/** Minimum number of player avatars required for Social Quest to run a round. */
export const MIN_PLAYERS_REQUIRED = 2

/**
 * Lists the userIds of player avatars currently present in the scene, local player
 * included. Uses the current SDK7 entity-component approach (PlayerIdentityData +
 * AvatarBase), not the deprecated getPlayersInScene().
 */
export function getPresentUserIds(): string[] {
    const userIds: string[] = []
    for (const [, identity] of engine.getEntitiesWith(PlayerIdentityData, AvatarBase)) {
        userIds.push(identity.address)
    }
    return userIds
}

export function getPlayerCount(): number {
    return getPresentUserIds().length
}
