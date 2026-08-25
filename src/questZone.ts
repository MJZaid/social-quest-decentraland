/**
 * Center and radius of the Social Quest gameplay area. Detection area only - no
 * visuals yet. X/Z only: this is a horizontal-only membership check (see
 * isInsideQuestZone below), so there is no Y component to this center - the
 * scene's new building layout centers the area around world position
 * (15.96, 0.65, 15.10), but the 0.65 (Y) belongs only to visual/physical scene
 * elements, never to this logical center.
 */
export const QUEST_ZONE_CENTER_X = 15.96
export const QUEST_ZONE_CENTER_Z = 15.1
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
