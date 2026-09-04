/**
 * Center and radius of the Social Quest gameplay area. Detection area only - no
 * visuals yet. X/Z only: this is a horizontal-only membership check (see
 * isInsideQuestZone below), so there is no Y component to this center.
 *
 * Re-centered on lampara.glb, the new landmark/start point. NOT derived from
 * the GLB's internal pivot - panel.glb already taught us that's unreliable
 * (its screen mesh sat ~7 units from its own Transform, wrong sign on X when
 * first computed). This center is instead the empirically measured player
 * position while standing at the lamp's visible base in a live preview.
 */
export const QUEST_ZONE_CENTER_X = 12.36
export const QUEST_ZONE_CENTER_Z = 10.66
export const QUEST_ZONE_RADIUS = 2.9

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
