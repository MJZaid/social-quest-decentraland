/** Center and radius of the Social Quest gameplay area. Detection area only - no visuals yet. */
export const QUEST_ZONE_CENTER_X = 14.5
export const QUEST_ZONE_CENTER_Z = 14.5
export const QUEST_ZONE_RADIUS = 4

const RADIUS_SQUARED = QUEST_ZONE_RADIUS * QUEST_ZONE_RADIUS

/**
 * Horizontal-only (X/Z) membership check - player height must never affect Quest
 * Zone membership, so jumping or small floor-height differences don't eject someone.
 * Uses squared distance to avoid an unnecessary Math.sqrt.
 */
export function isInsideQuestZone(x: number, z: number): boolean {
    const dx = x - QUEST_ZONE_CENTER_X
    const dz = z - QUEST_ZONE_CENTER_Z
    return dx * dx + dz * dz <= RADIUS_SQUARED
}
