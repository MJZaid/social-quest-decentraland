import { engine, Entity, Name, TextShape, TextAlignMode, Transform } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { isStateSyncronized } from '@dcl/sdk/network'
import { EntityNames } from '../assets/scene/entity-names'
import { requestLeaderboard, getLatestLeaderboardResponse, LeaderboardResponse } from './leaderboardNetwork'
import { LeaderboardRankedEntry } from './leaderboardRanking'
import { requestTopMatches, getTopMatchesResponse, TopMatchesResponse } from './topMatchesNetwork'

// -----------------------------------------------------------------------
// LEADERBOARD 3D DISPLAY - a permanent, always-visible summary rendered as
// floating TextShape entities on the physical leaderboard panel (entity name
// EntityNames.panel_glb). Purely a presentation layer: builds no ranking of
// its own, never touches Storage, and reuses exactly the same read APIs the
// 2D overlay already uses - requestLeaderboard()/getLatestLeaderboardResponse()
// from leaderboardNetwork.ts, requestTopMatches()/getTopMatchesResponse()
// from topMatchesNetwork.ts. Independent of playerSessionManager's 300ms zone
// poller and roundManager's 1s round tick - this owns a single interval of
// its own, since "keep a permanent display in sync" is a different concern
// with a different (much slower) cadence than either of those.
//
// THREE SECTIONS (this pass) - a public-facing SUMMARY, not the explorable
// 2D panel's equivalent:
//   1. TOP SOCIAL QUESTERS - top 3 by Social Points v2 (was top 5; shrunk to
//      make room for the two sections below)
//   2. TOP MATCH THIS WEEK - rank #1 pair only, from the THIS WEEK ranking
//   3. ALL-TIME BEST MATCH - rank #1 pair only, from the ALL TIME ranking
// No tabs, no pagination, no Top 5 for matches - see this task's own report
// for why a landmark sign stays simpler than the panel it summarizes.
//
// NETWORK CACHE CONVIVENCIA: this file calls requestTopMatches('thisWeek', 0)
// and requestTopMatches('allTime', 0) on its own 45s timer, completely
// independent of whatever scope/page a player currently has open in
// leaderboardUi.tsx's 2D panel. This is safe ONLY because
// topMatchesNetwork.ts caches responses keyed by (scope, page) - this sign's
// own page-0 requests write to their own cache entries and can never
// overwrite whatever page the 2D panel is reading (see
// topMatchesNetwork.ts's own responseCache doc comment). Before that fix,
// there was a single shared "latest response" slot that this sign's own
// periodic refresh would have silently clobbered out from under the 2D
// panel the moment a player was on any page other than page 0.
// -----------------------------------------------------------------------

/** Social Points now shows top 3 (was top 5) - the two freed-up row slots became the Top Match sections below. */
const SP_TOP_N = 3
/** Both Top Match feeds only ever need the pair ranked #1 - always page 0, never paginated on this sign. */
const MATCH_PAGE = 0
/** How often this checks whether it's time to re-request fresh data - NOT the request cadence itself, see REFRESH_INTERVAL_MS. */
const TICK_INTERVAL_MS = 1_000
/** How often each of the three feeds (Social Points, Weekly, All Time) actually re-requests, once its own initial request has fired - proximity/CPU-only server-side, still deliberately moderate, not a tick-rate poll. Same cadence for all three, no reason to stagger them. */
const REFRESH_INTERVAL_MS = 45_000

const TITLE_TEXT = 'TOP SOCIAL QUESTERS'
const LOADING_TEXT = 'LOADING SOCIAL QUESTERS...'
/** The pair connector - semantically load-bearing (it's what makes "Facemoon ♥ MeryElf" read as a couple, not decoration on top of already-complete information). Confirmed rendering correctly in Creator Hub - unlike every OTHER decorative glyph this task tried (a first-place star, a leading icon on each match section's mini-title, and the main title's own flanking stars), all removed after showing as missing-glyph squares in 3D TextShape's own font/atlas (distinct from the UI Label font those same glyphs were already proven in). */
const HEART = '♥'

const WEEKLY_TITLE_TEXT = 'TOP MATCH THIS WEEK'
/** Shortened from the brief's own longer phrasing ("Play together to make this week's board") for distance legibility on a single line - same meaning, fewer characters. */
const WEEKLY_EMPTY_PRIMARY = 'NO TOP MATCH YET'
const WEEKLY_EMPTY_SECONDARY = 'PLAY TOGETHER THIS WEEK'

const ALLTIME_TITLE_TEXT = 'ALL-TIME BEST MATCH'
const ALLTIME_EMPTY_PRIMARY = 'NO MATCHES YET'
const ALLTIME_EMPTY_SECONDARY = 'PLAY SOCIAL QUEST TO BUILD CONNECTIONS'

/** Shown in a match section's own empty-primary slot ONLY before this sign has ever received a `status: 'ready'` response for that scope - see MatchSectionDisplay's own doc comment for why this is a distinct state from the confirmed-empty one. */
const MATCH_LOADING_TEXT = 'LOADING...'

/**
 * Social Quest palette, matching leaderboardUi.tsx's own CREAM/SOCIAL_PINK/
 * TEAL_ACCENT values exactly - duplicated rather than imported, same "sibling
 * surfaces, no cross-file dependency" reasoning already established for
 * ui.tsx's own AGENDA_CREAM/AGENDA_PINK/AGENDA_TEAL. The old dominant yellow
 * is gone entirely from this file.
 */
const CREAM = Color4.create(0.97, 0.93, 0.86, 1)
const SOCIAL_PINK = Color4.create(1, 0.75, 0.9, 1)
const TEAL_ACCENT = Color4.create(0.4, 0.75, 1, 1)
/** Same value as ui.tsx/leaderboardUi.tsx's own MUTED - used for shared-answers lines and the divider, the two least-prioritized elements on this sign (see the layout section's own priority order). */
const MUTED = Color4.create(0.7, 0.7, 0.75, 1)

const TITLE_COLOR = CREAM
const RANK_COLOR = TEAL_ACCENT
const NAME_COLOR = CREAM
const SP_COLOR = SOCIAL_PINK
const MATCH_TITLE_COLOR = CREAM
const MATCH_NAME_COLOR = CREAM
const MATCH_HEART_COLOR = SOCIAL_PINK
const MATCH_AFFINITY_COLOR = SOCIAL_PINK
const MATCH_SHARED_COLOR = MUTED
const MATCH_EMPTY_PRIMARY_COLOR = CREAM
const MATCH_EMPTY_SECONDARY_COLOR = MUTED

/**
 * A dark, near-black outline on every text entity - TextShape supports
 * outlineWidth/outlineColor natively in this SDK (verified against the
 * installed package's own PBTextShape type). The panel's screen background
 * is a baked GLB texture we can't recolor from code (see this task's own
 * report) - an outline keeps cream/pink/teal text readable from several
 * meters away regardless of what that background actually looks like.
 */
const TEXT_OUTLINE_COLOR = Color3.create(0.05, 0.02, 0.05)
const TEXT_OUTLINE_WIDTH = 0.18

/**
 * Distance-legibility sizing, largest to smallest per this task's own
 * priority order (legibility > names > affinity/SP > shared answers).
 * ROW_FONT_SIZE_FIRST is a deliberately modest step up from ROW_FONT_SIZE
 * (not as large as TITLE_FONT_SIZE) - the #1 row should read as "a little
 * more important," never as a different sign entirely. The two match
 * sections' own mini-titles are intentionally smaller than the main title -
 * they're labels identifying a section, not headline content themselves.
 */
const TITLE_FONT_SIZE = 1.5
const ROW_FONT_SIZE = 1.3
const ROW_FONT_SIZE_FIRST = 1.5
const MATCH_TITLE_FONT_SIZE = 0.95
const MATCH_PAIR_FONT_SIZE = 1.1
const MATCH_PAIR_HEART_FONT_SIZE = 1.0
const MATCH_SHARED_FONT_SIZE = 0.78
const MATCH_EMPTY_PRIMARY_FONT_SIZE = 1.0
const MATCH_EMPTY_SECONDARY_FONT_SIZE = 0.72
/** Small, no outline (see createTextEntity's own `withOutline` param) - an outlined divider would look like a bordered dash instead of a clean subtle line. */
const DIVIDER_FONT_SIZE = 0.45

/**
 * Layout in the panel ENTITY's own local space (i.e. what a child Transform
 * with `parent: panelEntity` uses). SCREEN_CENTER_X is a visual calibration,
 * not the raw GLB-derived value - see this constant's own history: the
 * geometric derivation rendered visibly off-center in preview, and this was
 * arrived at empirically across multiple preview passes. Unchanged this
 * pass - only what's built around it changed.
 */
const SCREEN_CENTER_X = 0.7
/** Top of the screen's usable area (screen spans local y ~1.57 to ~5.87) - title sits just below the top edge. Confirmed on-screen in preview at this Y. */
const SCREEN_TITLE_Y = 5.55
/** Screen surface is at local z ~ -6.671 (facing +Z); text sits a small standoff in front of it to avoid z-fighting with the "pantalla" mesh. Confirmed on-screen in preview at this Z. */
const TEXT_LOCAL_Z = -6.6
/** Matches the screen's real local width (~2.71) - the outer bound every column below stays inside. */
const TEXT_WIDTH = 2.6

/**
 * Vertical layout budget: from SCREEN_TITLE_Y (5.55) down to the last line
 * (ALLTIME_SHARED_Y, computed below) at 1.67 - safely inside the screen's own
 * ~1.57 floor with a small margin, reusing the exact same screen bounds the
 * original single-purpose layout was calibrated against. Ten lines total
 * (main title, 3 Social Points rows, 3 lines per match section x 2) fit in
 * that budget by tightening the Social Points row gap slightly (0.65 -> 0.52)
 * from the interim single-purpose pass - the two rows Social Points gave up
 * (5 -> 3) are what actually bought the room for the two match sections, not
 * a tighter fit than before this whole feature existed.
 */
const SP_ROW_GAP = 0.52
const SP_ROW_1_Y = SCREEN_TITLE_Y - SP_ROW_GAP
const SP_ROW_2_Y = SP_ROW_1_Y - SP_ROW_GAP
const SP_ROW_3_Y = SP_ROW_2_Y - SP_ROW_GAP

/** Gap from one section's last line to the next section's own mini-title - deliberately bigger than the gaps within a section, so the three sections still read as visually distinct blocks. */
const SECTION_GAP = 0.48
/** Gap from a match section's own mini-title to its pair row. */
const MATCH_TITLE_TO_PAIR_GAP = 0.38
/** Gap from a match section's pair row to its shared-answers row. */
const MATCH_PAIR_TO_SHARED_GAP = 0.3

const WEEKLY_TITLE_Y = SP_ROW_3_Y - SECTION_GAP
const WEEKLY_PAIR_Y = WEEKLY_TITLE_Y - MATCH_TITLE_TO_PAIR_GAP
const WEEKLY_SHARED_Y = WEEKLY_PAIR_Y - MATCH_PAIR_TO_SHARED_GAP

/** ALL-TIME's own small upward nudge - its shared-answers line sat too close to the panel's lower glowing edge. Applied to the whole section as one block (title/pair/shared all shift by this same amount), so their internal gaps (MATCH_TITLE_TO_PAIR_GAP/MATCH_PAIR_TO_SHARED_GAP) stay exactly as they were. WEEKLY and Social Points are untouched. */
const ALLTIME_Y_LIFT = 0.12
const ALLTIME_TITLE_Y = WEEKLY_SHARED_Y - SECTION_GAP + ALLTIME_Y_LIFT
const ALLTIME_PAIR_Y = ALLTIME_TITLE_Y - MATCH_TITLE_TO_PAIR_GAP
const ALLTIME_SHARED_Y = ALLTIME_PAIR_Y - MATCH_PAIR_TO_SHARED_GAP

/** Dividers sit roughly midway through each SECTION_GAP - purely decorative, see DIVIDER_TEXT's own doc comment for why these are text, not geometry. */
const DIVIDER_1_Y = (SP_ROW_3_Y + WEEKLY_TITLE_Y) / 2
const DIVIDER_2_Y = (WEEKLY_SHARED_Y + ALLTIME_TITLE_Y) / 2
/**
 * A run of box-drawing dashes rather than actual mesh geometry - the brief
 * explicitly allows omitting dividers if they'd need "unnecessarily complex
 * geometry" (a MeshRenderer primitive + its own Material, oriented/parented
 * correctly, with no live preview available in this session to verify it
 * actually renders on the visible face without z-fighting or backface
 * culling issues). A TextShape is the one entity type already proven
 * reliable in this exact pipeline (same parent, same rotation, same font
 * system as every other line on this sign), so a low-alpha dash line reuses
 * a zero-risk mechanism instead of introducing an unverified one for a
 * purely decorative element.
 */
const DIVIDER_TEXT = '────────────────────'
const DIVIDER_COLOR = Color4.create(0.97, 0.93, 0.86, 0.12)

/**
 * Per-row column layout, shared by both the Social Points block and each
 * match section's affinity column. Offsets are relative to SCREEN_CENTER_X.
 *
 * ORIENTATION, RESOLVED (was a caveat in the previous pass, confirmed wrong
 * in Creator Hub and fixed here): the panel entity carries a 180° world
 * rotation (see main.composite's own Transform for entity "panel.glb"), and
 * every text child ALSO carries a 180° yaw (TEXT_ROTATION) to cancel that
 * back out for legible, non-mirrored glyphs. That double rotation makes
 * GLYPH GROWTH DIRECTION behave normally (TAM_MIDDLE_LEFT always grows
 * toward the visual right, TAM_MIDDLE_RIGHT always grows toward the visual
 * left, regardless of anchor placement) - but a child's own POSITION offset
 * only passes through the PARENT's single rotation, which DOES invert it:
 * a NEGATIVE offset from SCREEN_CENTER_X renders on the visual RIGHT, a
 * POSITIVE offset renders on the visual LEFT. Confirmed against the actual
 * Creator Hub screenshot: rank/SP were swapped exactly as this predicts, and
 * SP additionally clipped against the left edge because TAM_MIDDLE_RIGHT
 * at a positive (visual-left-rendering) offset grows FURTHER left, straight
 * off the screen - not a separate bug, the same one.
 *
 * The fix is exactly what was anticipated: COLUMN_SIDE_OFFSET's sign is
 * flipped from the previous pass. RANK now sits at a POSITIVE offset
 * (renders LEFT, TAM_MIDDLE_LEFT grows right/inward - safe) and SP/affinity
 * at a NEGATIVE offset (renders RIGHT, TAM_MIDDLE_RIGHT grows left/inward -
 * safe, no more clipping). No textAlign values changed - only this sign.
 */
const COLUMN_SIDE_OFFSET = -1.0
const RANK_COLUMN_X = SCREEN_CENTER_X - COLUMN_SIDE_OFFSET
const SP_COLUMN_X = SCREEN_CENTER_X + COLUMN_SIDE_OFFSET
const RANK_COLUMN_WIDTH = 0.6
const NAME_COLUMN_WIDTH = 1.5
const SP_COLUMN_WIDTH = 0.8

/**
 * Match pair-row layout - nameA/heart/nameB cluster left-of-center (mirrors
 * leaderboardUi.tsx's own TopMatchRow: names+heart together, affinity at the
 * far right), reusing SP_COLUMN_X as the affinity anchor for the exact same
 * right-edge alignment the Social Points column already uses above.
 *
 * Same orientation rule as the Social Points columns above: a POSITIVE
 * offset from SCREEN_CENTER_X renders on the visual LEFT. PAIR_HEART_X is
 * therefore positive (renders left-of-true-center, matching the mockup's
 * "names cluster left, affinity far right"). NameA needs to render LEFT of
 * the heart (further into positive-offset territory) with TAM_MIDDLE_RIGHT
 * (ends near the heart, grows further left/safe, away from the heart).
 * NameB needs to render RIGHT of the heart (less-positive/more-negative
 * offset) with TAM_MIDDLE_LEFT (starts near the heart, grows further
 * right/safe, away from the heart). PAIR_NAME_GAP was widened from the
 * previous pass's 0.1 (too tight - names visually ran into the heart,
 * reading as one fused word) to give real breathing room on both sides.
 */
const PAIR_HEART_X = SCREEN_CENTER_X + 0.35
const PAIR_NAME_GAP = 0.28
const PAIR_NAME_A_X = PAIR_HEART_X + PAIR_NAME_GAP
const PAIR_NAME_B_X = PAIR_HEART_X - PAIR_NAME_GAP
const PAIR_AFFINITY_X = SP_COLUMN_X
const PAIR_NAME_WIDTH = 1.1
const PAIR_HEART_WIDTH = 0.3
const PAIR_AFFINITY_WIDTH = 0.7

/**
 * Confirmed empirically in preview (orientation probe: identity read
 * mirrored, this yaw180 read correctly from the panel's front face) - a
 * child TextShape here does NOT inherit legible orientation "for free"
 * through the parent/child hierarchy the way plain position does, so this
 * is applied explicitly to every text entity below.
 */
const TEXT_ROTATION = Quaternion.fromEulerDegrees(0, 180, 0)

interface SocialPointsRowEntities {
    rank: Entity
    name: Entity
    sp: Entity
}

interface MatchSectionEntities {
    titleText: Entity
    nameA: Entity
    heart: Entity
    nameB: Entity
    affinity: Entity
    shared: Entity
    emptyPrimary: Entity
    emptySecondary: Entity
}

interface DisplayEntities {
    title: Entity
    spRows: SocialPointsRowEntities[]
    dividerAfterSp: Entity
    weekly: MatchSectionEntities
    dividerAfterWeekly: Entity
    allTime: MatchSectionEntities
}

/**
 * What a match section (WEEKLY or ALL TIME) should actually show right now -
 * deliberately a THIRD state beyond "has data" / "confirmed empty", because
 * "no rows[0] this tick" is NOT proof of "no eligible pair exists": it's
 * equally what a null response (nothing received yet), a `status:'hydrating'`
 * response, or a transient hydrating blip during a routine 45s refresh all
 * look like from this file's side. Only a `status: 'ready'` response is real
 * evidence either way - `rows[0]` present means a pair, `rows[0]` absent
 * means a genuinely empty (but confirmed, thresholded) ranking.
 *
 * - 'loading': no `status: 'ready'` response has EVER been seen yet for this
 *   scope this session - the only case that renders MATCH_LOADING_TEXT.
 * - 'empty': the LAST `status: 'ready'` response seen had no rows[0] - a
 *   real, confirmed "nothing eligible yet" per that scope's own threshold.
 * - 'pair': the LAST `status: 'ready'` response seen had a rows[0].
 *
 * Once a section reaches 'empty' or 'pair', it can only ever be replaced by
 * a NEWER `status: 'ready'` response (see resolveMatchSectionDisplay) -
 * never silently reverts to 'loading' just because one tick's cached
 * response happened to be null/hydrating. This is what keeps a routine
 * refresh from flashing the sign back to "LOADING..." (or worse, to a false
 * "NO MATCH YET") every 45 seconds: the last confirmed picture stays on
 * screen until a genuinely newer one replaces it.
 */
type MatchSectionDisplay =
    | { kind: 'loading' }
    | { kind: 'empty' }
    | { kind: 'pair'; pairKey: string; nameA: string; nameB: string; affinity: number; sharedValidAnswers: number }

/**
 * Folds a fresh (possibly null/hydrating) response into the previous sticky
 * display state for one section - the one place this file decides whether
 * to update what's on screen. Only a `status: 'ready'` response ever changes
 * `current`; anything else (null, hydrating) returns `current` UNCHANGED, by
 * design - see MatchSectionDisplay's own doc comment for why that's correct
 * rather than a bug.
 */
function resolveMatchSectionDisplay(current: MatchSectionDisplay, response: TopMatchesResponse | null): MatchSectionDisplay {
    if (!response || response.status !== 'ready') return current

    const top1 = response.rows[0]
    if (!top1) return { kind: 'empty' }

    return { kind: 'pair', pairKey: top1.pairKey, nameA: top1.displayNameA, nameB: top1.displayNameB, affinity: top1.affinity, sharedValidAnswers: top1.sharedValidAnswers }
}

let panelEntity: Entity | null = null
let display: DisplayEntities | null = null
let tickIntervalId: number | null = null

let hasRequestedSocialPoints = false
let lastSocialPointsRequestAt = 0
let hasRequestedWeekly = false
let lastWeeklyRequestAt = 0
let hasRequestedAllTime = false
let lastAllTimeRequestAt = 0

/** Sticky per-section display state - see MatchSectionDisplay's own doc comment. Starts 'loading' for both sections; only ever advances via resolveMatchSectionDisplay. */
let weeklyDisplay: MatchSectionDisplay = { kind: 'loading' }
let allTimeDisplay: MatchSectionDisplay = { kind: 'loading' }

/** Fingerprint of the last combined (Social Points + Weekly + All Time) state actually applied to the TextShapes - lets tick() skip rewriting everything when nothing changed. */
let lastAppliedFingerprint: string | null = null

/** Locates the panel by its Name component (EntityNames.panel_glb), never by a hardcoded entity id - Creator Hub can renumber entities on any re-save (this already happened once during Phase 2B-4). */
function findPanelEntity(): Entity | null {
    for (const [entity, name] of engine.getEntitiesWith(Name)) {
        if (name.value === EntityNames.panel_glb) return entity
    }
    return null
}

function setText(entity: Entity, text: string): void {
    TextShape.getMutable(entity).text = text
}

function createTextEntity(
    parent: Entity,
    localX: number,
    localY: number,
    fontSize: number,
    color: Color4,
    textAlign: TextAlignMode,
    width: number,
    withOutline: boolean = true
): Entity {
    const entity = engine.addEntity()
    Transform.create(entity, {
        parent,
        position: Vector3.create(localX, localY, TEXT_LOCAL_Z),
        rotation: TEXT_ROTATION
    })
    TextShape.create(entity, {
        text: '',
        fontSize,
        textAlign,
        width,
        textColor: color,
        outlineWidth: withOutline ? TEXT_OUTLINE_WIDTH : 0,
        outlineColor: TEXT_OUTLINE_COLOR
    })
    return entity
}

/**
 * One match section's worth of entities (mini-title, pair row
 * nameA/heart/nameB/affinity, shared-answers line, and the two empty-state
 * lines) - shared shape/positions for both WEEKLY and ALL TIME, only the Y
 * coordinates and title copy differ per call site (see ensureDisplayEntities).
 * No leading icon on the mini-title (a previous pass had one, flanking left
 * of the text like the main title's stars) - removed per this file's own
 * report: an un-flanked, single-sided decorative glyph that nobody has
 * confirmed renders correctly in 3D TextShape's own font/atlas (distinct
 * from the UI Label font this project's "✦" was originally proven in) isn't
 * worth the risk of a missing-glyph □ for a purely decorative element.
 */
function createMatchSection(parent: Entity, titleY: number, pairY: number, sharedY: number): MatchSectionEntities {
    return {
        titleText: createTextEntity(parent, SCREEN_CENTER_X, titleY, MATCH_TITLE_FONT_SIZE, MATCH_TITLE_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH),
        nameA: createTextEntity(parent, PAIR_NAME_A_X, pairY, MATCH_PAIR_FONT_SIZE, MATCH_NAME_COLOR, TextAlignMode.TAM_MIDDLE_RIGHT, PAIR_NAME_WIDTH),
        heart: createTextEntity(parent, PAIR_HEART_X, pairY, MATCH_PAIR_HEART_FONT_SIZE, MATCH_HEART_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, PAIR_HEART_WIDTH),
        nameB: createTextEntity(parent, PAIR_NAME_B_X, pairY, MATCH_PAIR_FONT_SIZE, MATCH_NAME_COLOR, TextAlignMode.TAM_MIDDLE_LEFT, PAIR_NAME_WIDTH),
        affinity: createTextEntity(parent, PAIR_AFFINITY_X, pairY, MATCH_PAIR_FONT_SIZE, MATCH_AFFINITY_COLOR, TextAlignMode.TAM_MIDDLE_RIGHT, PAIR_AFFINITY_WIDTH),
        shared: createTextEntity(parent, SCREEN_CENTER_X, sharedY, MATCH_SHARED_FONT_SIZE, MATCH_SHARED_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH),
        // Empty-state lines occupy the SAME Y slots as pairY/sharedY - only one
        // of {pair row + shared line} or {empty primary + empty secondary} is
        // ever non-empty text at a time (see applyMatchSection), so they never
        // visually overlap despite sharing a position.
        emptyPrimary: createTextEntity(parent, SCREEN_CENTER_X, pairY, MATCH_EMPTY_PRIMARY_FONT_SIZE, MATCH_EMPTY_PRIMARY_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH),
        emptySecondary: createTextEntity(parent, SCREEN_CENTER_X, sharedY, MATCH_EMPTY_SECONDARY_FONT_SIZE, MATCH_EMPTY_SECONDARY_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH)
    }
}

/** Creates every entity on the sign exactly once, the first time the panel entity is found - idempotent, safe to call every tick before the panel exists yet (e.g. while the composite is still loading). */
function ensureDisplayEntities(): DisplayEntities | null {
    if (display) return display
    if (!panelEntity) {
        panelEntity = findPanelEntity()
        if (!panelEntity) return null
    }

    // No flanking stars - a previous pass had "✦ TOP SOCIAL QUESTERS ✦"
    // (both stars proven fine in the 2D UI's own Label font, but that's a
    // DIFFERENT font/atlas from 3D TextShape - see this file's own report on
    // the match-section icons removed earlier for the same reason). Removed
    // per explicit feedback that they rendered as missing-glyph squares here
    // too - title is plain centered text now, same color/size/position/align.
    const title = createTextEntity(panelEntity, SCREEN_CENTER_X, SCREEN_TITLE_Y, TITLE_FONT_SIZE, TITLE_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH)

    const spRowYs = [SP_ROW_1_Y, SP_ROW_2_Y, SP_ROW_3_Y]
    const spRows: SocialPointsRowEntities[] = spRowYs.map((rowY, i) => {
        const fontSize = i === 0 ? ROW_FONT_SIZE_FIRST : ROW_FONT_SIZE
        return {
            rank: createTextEntity(panelEntity as Entity, RANK_COLUMN_X, rowY, fontSize, RANK_COLOR, TextAlignMode.TAM_MIDDLE_LEFT, RANK_COLUMN_WIDTH),
            name: createTextEntity(panelEntity as Entity, SCREEN_CENTER_X, rowY, fontSize, NAME_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, NAME_COLUMN_WIDTH),
            sp: createTextEntity(panelEntity as Entity, SP_COLUMN_X, rowY, fontSize, SP_COLOR, TextAlignMode.TAM_MIDDLE_RIGHT, SP_COLUMN_WIDTH)
        }
    })

    const dividerAfterSp = createTextEntity(panelEntity, SCREEN_CENTER_X, DIVIDER_1_Y, DIVIDER_FONT_SIZE, DIVIDER_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH, false)
    setText(dividerAfterSp, DIVIDER_TEXT)

    const weekly = createMatchSection(panelEntity, WEEKLY_TITLE_Y, WEEKLY_PAIR_Y, WEEKLY_SHARED_Y)
    setText(weekly.titleText, WEEKLY_TITLE_TEXT)

    const dividerAfterWeekly = createTextEntity(panelEntity, SCREEN_CENTER_X, DIVIDER_2_Y, DIVIDER_FONT_SIZE, DIVIDER_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH, false)
    setText(dividerAfterWeekly, DIVIDER_TEXT)

    const allTime = createMatchSection(panelEntity, ALLTIME_TITLE_Y, ALLTIME_PAIR_Y, ALLTIME_SHARED_Y)
    setText(allTime.titleText, ALLTIME_TITLE_TEXT)

    display = { title, spRows, dividerAfterSp, weekly, dividerAfterWeekly, allTime }
    return display
}

function applySocialPoints(response: LeaderboardResponse | null, entities: DisplayEntities): void {
    if (!response || response.status === 'hydrating') {
        setText(entities.title, LOADING_TEXT)
        for (const row of entities.spRows) {
            setText(row.rank, '')
            setText(row.name, '')
            setText(row.sp, '')
        }
        return
    }

    setText(entities.title, TITLE_TEXT)

    // #1's own special treatment is font size only now (ROW_FONT_SIZE_FIRST,
    // see ensureDisplayEntities) plus its already-distinct rank/name colors -
    // no extra glyph. A previous pass added a small star next to the name;
    // removed per this file's own report (an unconfirmed decorative glyph,
    // not worth the missing-glyph risk for something rank/color already communicate).
    for (let i = 0; i < SP_TOP_N; i++) {
        const entry: LeaderboardRankedEntry | undefined = response.top[i]
        const row = entities.spRows[i]
        setText(row.rank, entry ? `#${entry.rank}` : '')
        setText(row.name, entry ? entry.displayName : '')
        setText(row.sp, entry ? `${entry.socialPoints} SP` : '')
    }
}

/**
 * Renders a section from its RESOLVED sticky display state (see
 * MatchSectionDisplay's own doc comment), never straight from a raw
 * response - the 'loading'/'empty'/'pair' distinction is already fully
 * decided by resolveMatchSectionDisplay before this ever runs. Never
 * recalculates affinity or sharedValidAnswers (both came straight off
 * TopMatchRankedEntry when the 'pair' state was captured, the same DTO
 * leaderboardUi.tsx's own TopMatchRow renders), never re-applies a threshold
 * (THIS_WEEK_MIN_SHARED_ANSWERS/ALL_TIME_MIN_SHARED_ANSWERS are already
 * baked into `rows` by the manager - an ineligible pair simply never
 * appears in `rows` at all, so a captured 'empty' state IS the correctly-
 * thresholded empty state, not something this function decides itself).
 */
function applyMatchSection(entities: MatchSectionEntities, display: MatchSectionDisplay, emptyPrimary: string, emptySecondary: string): void {
    if (display.kind === 'loading') {
        setText(entities.nameA, '')
        setText(entities.heart, '')
        setText(entities.nameB, '')
        setText(entities.affinity, '')
        setText(entities.shared, '')
        setText(entities.emptyPrimary, MATCH_LOADING_TEXT)
        setText(entities.emptySecondary, '')
        return
    }

    if (display.kind === 'empty') {
        setText(entities.nameA, '')
        setText(entities.heart, '')
        setText(entities.nameB, '')
        setText(entities.affinity, '')
        setText(entities.shared, '')
        setText(entities.emptyPrimary, emptyPrimary)
        setText(entities.emptySecondary, emptySecondary)
        return
    }

    setText(entities.emptyPrimary, '')
    setText(entities.emptySecondary, '')
    setText(entities.nameA, display.nameA)
    setText(entities.heart, HEART)
    setText(entities.nameB, display.nameB)
    setText(entities.affinity, `${Math.round(display.affinity)}%`)
    setText(entities.shared, `${display.sharedValidAnswers} SHARED ANSWER${display.sharedValidAnswers === 1 ? '' : 'S'}`)
}

/** Cheap identity check for "did anything actually change" across all three feeds - avoids rewriting every TextShape on the sign every tick when nothing changed. Not a deep-equal: rank/userId/socialPoints for Social Points, and the resolved sticky display state for each match section, is exactly what's rendered, so it's exactly what needs to match. */
function fingerprintOf(spResponse: LeaderboardResponse | null, weekly: MatchSectionDisplay, allTime: MatchSectionDisplay): string {
    const spPart = !spResponse ? 'sp:none' : spResponse.status !== 'ready' ? `sp:${spResponse.status}` : `sp:${spResponse.top.map((entry) => `${entry.rank}:${entry.userId}:${entry.socialPoints}`).join('|')}`
    return `${spPart}##${matchDisplayFingerprint('weekly', weekly)}##${matchDisplayFingerprint('alltime', allTime)}`
}

function matchDisplayFingerprint(label: string, display: MatchSectionDisplay): string {
    if (display.kind === 'loading') return `${label}:loading`
    if (display.kind === 'empty') return `${label}:empty`
    return `${label}:${display.pairKey}:${Math.round(display.affinity)}:${display.sharedValidAnswers}`
}

function tick(): void {
    const entities = ensureDisplayEntities()

    if (isStateSyncronized()) {
        if (!hasRequestedSocialPoints) {
            requestLeaderboard(SP_TOP_N)
            hasRequestedSocialPoints = true
            lastSocialPointsRequestAt = Date.now()
        } else if (Date.now() - lastSocialPointsRequestAt >= REFRESH_INTERVAL_MS) {
            requestLeaderboard(SP_TOP_N)
            lastSocialPointsRequestAt = Date.now()
        }

        if (!hasRequestedWeekly) {
            requestTopMatches('thisWeek', MATCH_PAGE)
            hasRequestedWeekly = true
            lastWeeklyRequestAt = Date.now()
        } else if (Date.now() - lastWeeklyRequestAt >= REFRESH_INTERVAL_MS) {
            requestTopMatches('thisWeek', MATCH_PAGE)
            lastWeeklyRequestAt = Date.now()
        }

        if (!hasRequestedAllTime) {
            requestTopMatches('allTime', MATCH_PAGE)
            hasRequestedAllTime = true
            lastAllTimeRequestAt = Date.now()
        } else if (Date.now() - lastAllTimeRequestAt >= REFRESH_INTERVAL_MS) {
            requestTopMatches('allTime', MATCH_PAGE)
            lastAllTimeRequestAt = Date.now()
        }
    }

    if (!entities) return // panel not found yet (composite still loading) - retried next tick

    const spResponse = getLatestLeaderboardResponse()
    const weeklyResponse = getTopMatchesResponse('thisWeek', MATCH_PAGE)
    const allTimeResponse = getTopMatchesResponse('allTime', MATCH_PAGE)

    // Fold this tick's (possibly null/hydrating) responses into the sticky
    // per-section state - see resolveMatchSectionDisplay's own doc comment.
    // A null/hydrating response here leaves weeklyDisplay/allTimeDisplay
    // exactly as they were, so a routine 45s refresh can never flash the
    // sign back to "LOADING..." or a false empty state while a perfectly
    // good previous result is already on screen.
    weeklyDisplay = resolveMatchSectionDisplay(weeklyDisplay, weeklyResponse)
    allTimeDisplay = resolveMatchSectionDisplay(allTimeDisplay, allTimeResponse)

    const fingerprint = fingerprintOf(spResponse, weeklyDisplay, allTimeDisplay)
    if (fingerprint === lastAppliedFingerprint) return
    lastAppliedFingerprint = fingerprint

    applySocialPoints(spResponse, entities)
    applyMatchSection(entities.weekly, weeklyDisplay, WEEKLY_EMPTY_PRIMARY, WEEKLY_EMPTY_SECONDARY)
    applyMatchSection(entities.allTime, allTimeDisplay, ALLTIME_EMPTY_PRIMARY, ALLTIME_EMPTY_SECONDARY)
}

/** Starts the permanent panel display. Idempotent (mirrors playerSessionManager.start()'s own guard) - safe even if called more than once. */
export function initLeaderboardDisplay3D(): void {
    if (tickIntervalId !== null) return
    tickIntervalId = setInterval(tick, TICK_INTERVAL_MS)
}
