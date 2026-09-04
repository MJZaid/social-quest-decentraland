import { engine, Entity, Name, TextShape, TextAlignMode, Transform } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { isStateSyncronized } from '@dcl/sdk/network'
import { EntityNames } from '../assets/scene/entity-names'
import { requestLeaderboard, getLatestLeaderboardResponse, LeaderboardResponse } from './leaderboardNetwork'
import { LeaderboardRankedEntry } from './leaderboardRanking'

// -----------------------------------------------------------------------
// LEADERBOARD 3D DISPLAY (Phase 2B-4) - a permanent, always-visible Top 5
// scoreboard rendered as floating TextShape entities on the physical
// leaderboard panel (entity name EntityNames.panel_glb). Purely a
// presentation layer: builds no ranking of its own, never touches Storage,
// and reuses exactly requestLeaderboard()/getLatestLeaderboardResponse()
// from leaderboardNetwork.ts - the same read API the 2D overlay (Phase
// 2B-3) already uses. Independent of playerSessionManager's 300ms zone
// poller and roundManager's 1s round tick - this owns a single interval of
// its own, since "keep a permanent display in sync" is a different concern
// with a different (much slower) cadence than either of those.
// -----------------------------------------------------------------------

const TOP_N = 5
/** How often this checks whether it's time to re-request fresh data - NOT the request cadence itself, see REFRESH_INTERVAL_MS. */
const TICK_INTERVAL_MS = 1_000
/** How often a fresh requestLeaderboard() actually goes out, once the initial request has fired - proximity/CPU-only server-side, still deliberately moderate, not a tick-rate poll. */
const REFRESH_INTERVAL_MS = 45_000

const TITLE_TEXT = 'TOP SOCIAL QUESTERS'
const LOADING_TEXT = 'LOADING SOCIAL QUESTERS...'

const TITLE_COLOR = Color4.create(1, 0.85, 0.2, 1)
const ROW_COLOR = Color4.create(1, 1, 1, 1)
/** Bumped up progressively across visual calibration passes in preview - 0.45/0.35 read too small, then 0.65/0.48 still too small at normal viewing distance. */
const TITLE_FONT_SIZE = 1.35
const ROW_FONT_SIZE = 1.15

/**
 * Layout in the panel ENTITY's own local space (i.e. what a child Transform
 * with `parent: panelEntity` uses). SCREEN_CENTER_X is a visual calibration,
 * not the raw GLB-derived value: the geometric derivation (-0.693, from
 * panel.glb's node translation + "pantalla" mesh bounds) rendered visibly
 * off-center in preview. An intermediate reasoned correction (0.52, from
 * measuring the on-screen offset in a preview screenshot) still left the
 * text slightly right of center; 0.7 confirmed closer to centered visually
 * across multiple preview passes. Calibrated empirically in preview, not
 * re-derived from the GLB.
 */
const SCREEN_CENTER_X = 0.7
/** Top of the screen's usable area (screen spans local y ~1.57 to ~5.87) - title sits just below the top edge. Confirmed on-screen in preview at this Y. */
const SCREEN_TITLE_Y = 5.55
/** Vertical gap between the title/each row - 6 lines (title + 5 rows) across the screen's ~4.3-unit height. */
const ROW_SPACING = 0.5
/** Screen surface is at local z ~ -6.671 (facing +Z); text sits a small standoff in front of it to avoid z-fighting with the "pantalla" mesh. Confirmed on-screen in preview at this Z. */
const TEXT_LOCAL_Z = -6.6
/** Matches the screen's real local width (~2.71) so centered text doesn't overhang the panel's edges. */
const TEXT_WIDTH = 2.6
/**
 * Confirmed empirically in preview (orientation probe: identity read
 * mirrored, this yaw180 read correctly from the panel's front face) - a
 * child TextShape here does NOT inherit legible orientation "for free"
 * through the parent/child hierarchy the way plain position does, so this
 * is applied explicitly to every text entity below.
 */
const TEXT_ROTATION = Quaternion.fromEulerDegrees(0, 180, 0)

interface DisplayEntities {
    title: Entity
    rows: Entity[]
}

let panelEntity: Entity | null = null
let display: DisplayEntities | null = null
let tickIntervalId: number | null = null
let hasRequestedInitial = false
let lastRequestAt = 0
/** Fingerprint of the last response actually applied to the TextShapes - lets checkForUpdate() skip rewriting identical text every tick (see its own doc comment). */
let lastAppliedFingerprint: string | null = null

/** Locates the panel by its Name component (EntityNames.panel_glb), never by a hardcoded entity id - Creator Hub can renumber entities on any re-save (this already happened once during Phase 2B-4). */
function findPanelEntity(): Entity | null {
    for (const [entity, name] of engine.getEntitiesWith(Name)) {
        if (name.value === EntityNames.panel_glb) return entity
    }
    return null
}

function createTextEntity(parent: Entity, localY: number, fontSize: number, color: Color4): Entity {
    const entity = engine.addEntity()
    Transform.create(entity, {
        parent,
        position: Vector3.create(SCREEN_CENTER_X, localY, TEXT_LOCAL_Z),
        rotation: TEXT_ROTATION
    })
    TextShape.create(entity, {
        text: '',
        fontSize,
        textAlign: TextAlignMode.TAM_MIDDLE_CENTER,
        width: TEXT_WIDTH,
        textColor: color
    })
    return entity
}

/** Creates the title + 5 row entities exactly once, the first time the panel entity is found - idempotent, safe to call every tick before the panel exists yet (e.g. while the composite is still loading). */
function ensureDisplayEntities(): DisplayEntities | null {
    if (display) return display
    if (!panelEntity) {
        panelEntity = findPanelEntity()
        if (!panelEntity) return null
    }

    const title = createTextEntity(panelEntity, SCREEN_TITLE_Y, TITLE_FONT_SIZE, TITLE_COLOR)
    const rows: Entity[] = []
    for (let i = 0; i < TOP_N; i++) {
        rows.push(createTextEntity(panelEntity, SCREEN_TITLE_Y - ROW_SPACING * (i + 1), ROW_FONT_SIZE, ROW_COLOR))
    }
    display = { title, rows }
    return display
}

/** `#1  DisplayName  —  800 SP` - no userId, straight from the existing DTO's displayName/socialPoints (see leaderboardRanking.ts), no local fallback invented here. */
function formatRow(entry: LeaderboardRankedEntry | undefined): string {
    if (!entry) return ''
    return `#${entry.rank}  ${entry.displayName}  —  ${entry.socialPoints} SP`
}

function applyResponse(response: LeaderboardResponse | null, entities: DisplayEntities): void {
    if (!response || response.status === 'hydrating') {
        TextShape.getMutable(entities.title).text = LOADING_TEXT
        for (const row of entities.rows) TextShape.getMutable(row).text = ''
        return
    }

    TextShape.getMutable(entities.title).text = TITLE_TEXT
    for (let i = 0; i < TOP_N; i++) {
        TextShape.getMutable(entities.rows[i]).text = formatRow(response.top[i])
    }
}

/** Cheap identity check for "did the data actually change" - avoids rewriting all 6 TextShapes every tick when the response is unchanged. Not a deep-equal: rank+userId+socialPoints per Top N entry is exactly what's rendered, so it's exactly what needs to match. */
function fingerprintOf(response: LeaderboardResponse | null): string {
    if (!response) return 'none'
    if (response.status !== 'ready') return response.status
    return response.top.map((entry) => `${entry.rank}:${entry.userId}:${entry.socialPoints}`).join('|')
}

function tick(): void {
    const entities = ensureDisplayEntities()

    if (!hasRequestedInitial) {
        // Gates only the request - the display-update code below must still
        // run every tick regardless of sync state (a previous version
        // returned the whole tick() here, which left the title stuck on its
        // initial empty text instead of "LOADING..." for as long as sync
        // hadn't completed).
        if (isStateSyncronized()) {
            requestLeaderboard(TOP_N)
            hasRequestedInitial = true
            lastRequestAt = Date.now()
        }
    } else if (isStateSyncronized() && Date.now() - lastRequestAt >= REFRESH_INTERVAL_MS) {
        requestLeaderboard(TOP_N)
        lastRequestAt = Date.now()
    }

    if (!entities) return // panel not found yet (composite still loading) - retried next tick

    const response = getLatestLeaderboardResponse()
    const fingerprint = fingerprintOf(response)
    if (fingerprint === lastAppliedFingerprint) return
    lastAppliedFingerprint = fingerprint
    applyResponse(response, entities)
}

/** Starts the permanent panel display. Idempotent (mirrors playerSessionManager.start()'s own guard) - safe even if called more than once. */
export function initLeaderboardDisplay3D(): void {
    if (tickIntervalId !== null) return
    tickIntervalId = setInterval(tick, TICK_INTERVAL_MS)
}
