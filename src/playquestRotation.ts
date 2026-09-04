import { engine, Entity, Name, Transform } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { EntityNames } from '../assets/scene/entity-names'

// -----------------------------------------------------------------------
// PLAYQUEST ROTATION - purely visual, continuous slow spin for the
// playquest.glb holographic ring around its own vertical (Y) axis. Only
// rotates this one entity - its Transform.position/scale are never
// touched, and no other object (lamp, Quest Zone, leaderboard, etc.) is
// affected. Safe now that the GLB's own pivot has been re-centered in
// Blender to (~0, ~0) on X/Z - see the report before this change: rotating
// the previous export would have orbited the ring around a point ~4 units
// off its own center instead of spinning in place.
// -----------------------------------------------------------------------

/** Degrees per second - slow, elegant, holographic. */
const ROTATION_DEG_PER_SECOND = 12

let playquestEntity: Entity | null = null
let systemRegistered = false

/** Locates playquest.glb by its Name component, never by a hardcoded entity id - same reasoning as the leaderboard panel lookup (Creator Hub can renumber composite entities on any re-save). */
function findPlayquestEntity(): Entity | null {
    for (const [entity, name] of engine.getEntitiesWith(Name)) {
        if (name.value === EntityNames.playquest_glb) return entity
    }
    return null
}

/**
 * Rotates only playquest.glb around Y, continuously. Same dt-accumulated
 * Quaternion pattern as the SDK's own documented spin-system example (see
 * .agents/skills/animations-tweens/references/animation-patterns.md) -
 * independent of framerate.
 */
function spinPlayquest(dt: number): void {
    if (!playquestEntity) {
        playquestEntity = findPlayquestEntity()
        if (!playquestEntity) return // composite still loading - retried next frame
    }

    const transform = Transform.getMutable(playquestEntity)
    const currentEuler = Quaternion.toEulerAngles(transform.rotation)
    transform.rotation = Quaternion.fromEulerDegrees(currentEuler.x, currentEuler.y + ROTATION_DEG_PER_SECOND * dt, currentEuler.z)
}

/** Starts the playquest.glb spin. Idempotent - safe even if called more than once. */
export function initPlayquestRotation(): void {
    if (systemRegistered) return
    systemRegistered = true
    engine.addSystem(spinPlayquest)
}
