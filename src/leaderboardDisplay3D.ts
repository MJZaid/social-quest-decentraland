import { engine, Entity, Name, TextShape, TextAlignMode, Transform, MeshRenderer, Material, MaterialTransparencyMode } from '@dcl/sdk/ecs'
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
 *
 * Color/outline-only pass: brings this sign's palette the rest of the way in
 * line with the illustrated 2D Leaderboard panel - GOLD is new here (same
 * value as leaderboardUi.tsx's own GOLD, reused rather than invented),
 * reserved strictly for #1's rank/SP and the ALL-TIME title, the same
 * "controlled ranking accent, never a panel-wide fill" rule that file
 * documents. MUTED_CREAM is also new: a warmer, lighter secondary tone for
 * shared-answers/empty-state-subtext lines specifically, since this sign
 * still sits on the SAME unrecolorable baked GLB background as before (only
 * the 2D UI panels became cream - this sign did not), so text here still
 * needs to stay on the light end for contrast, just distinguishable from the
 * brighter CREAM used for names/titles.
 */
const CREAM = Color4.create(0.97, 0.93, 0.86, 1)
const SOCIAL_PINK = Color4.create(1, 0.75, 0.9, 1)
const TEAL_ACCENT = Color4.create(0.4, 0.75, 1, 1)
/** Same value as ui.tsx/leaderboardUi.tsx's own MUTED - kept only for DIVIDER_COLOR's own reasoning below (a faint decorative line, not text). Text that previously used this flat gray (shared answers, empty-state subtext) now uses the lighter MUTED_CREAM instead - see that constant's own doc comment. */
const MUTED = Color4.create(0.7, 0.7, 0.75, 1)
/** Same value as leaderboardUi.tsx's own GOLD - the controlled ranking/achievement accent, used ONLY for #1's rank+SP in TOP SOCIAL QUESTERS (no longer in any section title - see ALLTIME_TITLE_COLOR's own doc comment). Never a panel-wide fill. */
const GOLD = Color4.create(0.8, 0.62, 0.22, 1)
/** A warmer, lighter secondary tone than plain MUTED - blended toward CREAM specifically for the two lowest-priority text lines on this sign (shared-answers counts, empty-state subtext) per explicit "muted/cream" feedback; still clearly secondary next to CREAM-colored names/titles, but warmer and easier to read against the baked GLB background than the flatter gray MUTED. */
const MUTED_CREAM = Color4.create(0.85, 0.81, 0.75, 1)

/** Changed from CREAM to TEAL_ACCENT - per explicit follow-up, all three section titles (this, WEEKLY_TITLE_COLOR, ALLTIME_TITLE_COLOR) now share the exact same color for visual uniformity across the sign. */
const TITLE_COLOR = TEAL_ACCENT
/** Non-#1 rank color (Social Points) - #1 uses GOLD instead, applied per-row at creation time (see ensureDisplayEntities' own spRows map). */
const RANK_COLOR = TEAL_ACCENT
const NAME_COLOR = CREAM
/** Non-#1 SP color (Social Points) - #1 uses GOLD instead, same per-row treatment as RANK_COLOR. Changed from the old SOCIAL_PINK to TEAL per explicit "SP: TEAL" instruction - pink is now reserved for the heart glyph and stays out of the numeric columns here, mirroring leaderboardUi.tsx's own LeaderboardRow (SP figure = TEAL, not pink). */
const SP_COLOR = TEAL_ACCENT
/** WEEKLY's own mini-title color - teal/mint. Unchanged this pass - it was already the reference value TITLE_COLOR/ALLTIME_TITLE_COLOR were both brought in line with, per explicit "usa como referencia... TOP MATCH THIS WEEK." */
const WEEKLY_TITLE_COLOR = TEAL_ACCENT
/** Changed from GOLD to TEAL_ACCENT - per explicit follow-up, ALL-TIME's own extra visual weight ("un poquito más de peso que Weekly," the reason GOLD was chosen originally) is retraded for uniformity across all three section titles instead. GOLD itself is untouched and still used for #1's rank+SP - it just no longer appears in any title. */
const ALLTIME_TITLE_COLOR = TEAL_ACCENT
const MATCH_NAME_COLOR = CREAM
const MATCH_HEART_COLOR = SOCIAL_PINK
/** Changed from SOCIAL_PINK to TEAL per explicit "affinity % teal" instruction, for both WEEKLY and ALL-TIME. */
const MATCH_AFFINITY_COLOR = TEAL_ACCENT
/** Changed from flat MUTED to the warmer MUTED_CREAM - see that constant's own doc comment. */
const MATCH_SHARED_COLOR = MUTED_CREAM
const MATCH_EMPTY_PRIMARY_COLOR = CREAM
/** Changed from flat MUTED to the warmer MUTED_CREAM ("muted claro") - see that constant's own doc comment. */
const MATCH_EMPTY_SECONDARY_COLOR = MUTED_CREAM

/**
 * A dark, near-black outline on every text entity - TextShape supports
 * outlineWidth/outlineColor natively in this SDK (verified against the
 * installed package's own PBTextShape type). The panel's screen background
 * is a baked GLB texture we can't recolor from code (see this task's own
 * report) - an outline keeps cream/pink/teal/gold text readable from several
 * meters away regardless of what that background actually looks like.
 *
 * Width nudged 0.18 -> 0.20 (a small, deliberately non-dramatic bump) for
 * this color pass - contrast is the absolute priority per explicit
 * instruction, and the new GOLD/TEAL text in particular benefits from a
 * slightly firmer edge; the color itself (already near-black) was left
 * alone - there's no meaningful room to darken 0.05/0.02/0.05 further.
 */
const TEXT_OUTLINE_COLOR = Color3.create(0.05, 0.02, 0.05)
const TEXT_OUTLINE_WIDTH = 0.2

/**
 * Distance-legibility sizing, largest to smallest per this task's own
 * priority order (legibility > names > affinity/SP > shared answers).
 * ROW_FONT_SIZE_FIRST is a deliberately modest step up from ROW_FONT_SIZE -
 * the #1 row should read as "a little more important," never as a different
 * sign entirely.
 *
 * TITLE_FONT_SIZE matches MATCH_TITLE_FONT_SIZE exactly - all three section
 * titles (TOP SOCIAL QUESTERS/TOP MATCH THIS WEEK/ALL-TIME BEST MATCH) are
 * the same size, so TOP SOCIAL QUESTERS reads as one of three equal
 * sections, not a general panel title. Bumped together 0.95 -> 1.10 per
 * explicit follow-up ("un poco más grandes") - all three titles are exactly
 * 19 characters long (verified by count), so none carries more width risk
 * than another at any shared size; 1.10 is still well under the 1.5 this
 * same TEXT_WIDTH bound already carried without incident before the
 * previous pass shrank it purely for hierarchy (not width) reasons, so this
 * increase was judged safe without needing the 1.05 fallback.
 *
 * NAME_FONT_SIZE is new - a single shared size for every human name on this
 * sign (Social Points #1/#2/#3, WEEKLY nameA/nameB, ALL-TIME nameA/nameB),
 * replacing what used to be three different values (ROW_FONT_SIZE_FIRST/
 * ROW_FONT_SIZE for Social Points names, MATCH_PAIR_FONT_SIZE for match
 * names) per explicit "todos deben tener exactamente el mismo tamaño
 * visual" instruction. Reuses MATCH_PAIR_FONT_SIZE's own existing value
 * (1.1, already proven at both WEEKLY and ALL-TIME) rather than inventing a
 * new number. ROW_FONT_SIZE/ROW_FONT_SIZE_FIRST still exist and are
 * unchanged - they now govern ONLY rank+SP in each Social Points row (not
 * name), preserving #1's rank/SP size difference exactly as it was; #1 still
 * stands out through GOLD color alone for its name, never size. Match
 * section names use NAME_FONT_SIZE instead of MATCH_PAIR_FONT_SIZE now -
 * MATCH_PAIR_FONT_SIZE itself is untouched in value and now used solely for
 * affinity (see createMatchSection).
 */
const TITLE_FONT_SIZE = 1.1
const ROW_FONT_SIZE = 1.3
const ROW_FONT_SIZE_FIRST = 1.5
const MATCH_TITLE_FONT_SIZE = 1.1
const NAME_FONT_SIZE = 1.1
/** Affinity fontSize only now (see NAME_FONT_SIZE's own doc comment on why match names moved off this constant) - value unchanged. */
const MATCH_PAIR_FONT_SIZE = 1.1
const MATCH_PAIR_HEART_FONT_SIZE = 1.0
const MATCH_SHARED_FONT_SIZE = 0.78
const MATCH_EMPTY_PRIMARY_FONT_SIZE = 1.0
const MATCH_EMPTY_SECONDARY_FONT_SIZE = 0.72
/** Small, no outline (see createTextEntity's own `withOutline` param) - an outlined divider would look like a bordered dash instead of a clean subtle line. */
const DIVIDER_FONT_SIZE = 0.45
/** DIVIDER_FONT_SIZE's own color - only still needed as a valid argument for the dash-text divider entities (dividerAfterSp/dividerAfterWeekly in ensureDisplayEntities), which are kept structurally but never have their text set (empty text, so this color has never actually been visible - there is no visible divider of any kind anymore, see DIVIDER_1_Y's own doc comment). */
const DIVIDER_COLOR = Color4.create(0.97, 0.93, 0.86, 0.12)

/**
 * Layout in the panel ENTITY's own local space (i.e. what a child Transform
 * with `parent: panelEntity` uses). SCREEN_CENTER_X is a visual calibration,
 * not the raw GLB-derived value - see this constant's own history: the
 * geometric derivation rendered visibly off-center in preview, and this was
 * arrived at empirically across multiple preview passes. Unchanged this
 * pass - only what's built around it changed.
 */
const SCREEN_CENTER_X = 0.7
/**
 * Lowered again this pass, 5.22 -> 5.02, to make room for a notably bigger
 * LEADERBOARD plate (see TITLE_PLATE_WIDTH's own doc comment for the full
 * top-down budget) - per explicit follow-up that the plate still "se ve
 * pequeña" and should read as "un verdadero encabezado decorativo." Screen
 * spans local y ~1.57 to ~5.87 - the plate, not this title, now owns the
 * area near the top edge.
 */
const SCREEN_TITLE_Y = 5.02
/** Screen surface is at local z ~ -6.671 (facing +Z); text sits a small standoff in front of it to avoid z-fighting with the "pantalla" mesh. Confirmed on-screen in preview at this Z. */
const TEXT_LOCAL_Z = -6.6
/** Matches the screen's real local width (~2.71) - the outer bound every column below stays inside. */
const TEXT_WIDTH = 2.6

/**
 * Vertical layout budget for the SOCIAL POINTS block only (title + 3 rows) -
 * compacted further this pass, on top of the previous pass's own cut, per
 * explicit follow-up that the block still "se ve más grande que los otros."
 * SP_TITLE_TO_ROW_GAP (title -> row #1) went 0.52 -> 0.40 -> 0.32.
 * SP_ROW_GAP (row -> row, #1-#2 and #2-#3) went 0.52 -> 0.46 -> 0.40.
 * By design, SP_ROW_3_Y lands on the exact same 3.90 it already had after
 * the previous pass (a coincidence of this round's specific numbers, not a
 * deliberate target) - DIVIDER_1_Y (which depends on it) therefore doesn't
 * move again either. X positions (RANK_COLUMN_X/SCREEN_CENTER_X/SP_COLUMN_X)
 * remain untouched - only Y moved, per explicit instruction.
 */
const SP_TITLE_TO_ROW_GAP = 0.32
const SP_ROW_GAP = 0.4
const SP_ROW_1_Y = SCREEN_TITLE_Y - SP_TITLE_TO_ROW_GAP
const SP_ROW_2_Y = SP_ROW_1_Y - SP_ROW_GAP
const SP_ROW_3_Y = SP_ROW_2_Y - SP_ROW_GAP

/** Gap from one section's last line to the next section's own mini-title - deliberately bigger than the gaps within a section, so the three sections still read as visually distinct blocks. Still used for the WEEKLY -> ALL-TIME gap below - unchanged. No longer used for Social Points -> WEEKLY (see WEEKLY_TITLE_Y's own doc comment on why that link was deliberately cut this pass). */
const SECTION_GAP = 0.48
/** Gap from a match section's own mini-title to its pair row. */
const MATCH_TITLE_TO_PAIR_GAP = 0.38
/** Gap from a match section's pair row to its shared-answers row. */
const MATCH_PAIR_TO_SHARED_GAP = 0.3

/**
 * FROZEN literal, not `SP_ROW_3_Y - SECTION_GAP` anymore - deliberately
 * decoupled from the Social Points block this pass, per explicit "no tocar
 * posiciones de Weekly y All-Time salvo que dependan de una constante
 * compartida que tengas que separar." 3.51 is the EXACT value the old
 * formula already produced (SP_ROW_3_Y was 3.99 before this pass's
 * compaction, minus the old SECTION_GAP of 0.48) - so WEEKLY_PAIR_Y/
 * WEEKLY_SHARED_Y/ALLTIME_* / DIVIDER_2_Y below (all still computed FROM this
 * constant, formulas untouched) evaluate to the exact same numbers as
 * before this pass, byte-for-byte. Only DIVIDER_1_Y (a midpoint between the
 * now-compacted SP_ROW_3_Y and this fixed anchor) shifts slightly as a
 * natural consequence - see that constant's own doc comment.
 */
const WEEKLY_TITLE_Y = 3.51
const WEEKLY_PAIR_Y = WEEKLY_TITLE_Y - MATCH_TITLE_TO_PAIR_GAP
const WEEKLY_SHARED_Y = WEEKLY_PAIR_Y - MATCH_PAIR_TO_SHARED_GAP

/** ALL-TIME's own small upward nudge - its shared-answers line sat too close to the panel's lower glowing edge. Applied to the whole section as one block (title/pair/shared all shift by this same amount), so their internal gaps (MATCH_TITLE_TO_PAIR_GAP/MATCH_PAIR_TO_SHARED_GAP) stay exactly as they were. WEEKLY and Social Points are untouched. */
const ALLTIME_Y_LIFT = 0.12
const ALLTIME_TITLE_Y = WEEKLY_SHARED_Y - SECTION_GAP + ALLTIME_Y_LIFT
const ALLTIME_PAIR_Y = ALLTIME_TITLE_Y - MATCH_TITLE_TO_PAIR_GAP
const ALLTIME_SHARED_Y = ALLTIME_PAIR_Y - MATCH_PAIR_TO_SHARED_GAP

/**
 * Y positions for the two (now text-only, invisible) divider entities - see
 * dividerAfterSp/dividerAfterWeekly in ensureDisplayEntities. The visible
 * teal divider PLANES that used to sit at these same Y values were removed
 * per explicit "quitar completamente las líneas divisorias" instruction;
 * these two Y constants stay defined because the empty dash-text entities
 * (kept structurally, never visible - see their own doc comment) still
 * reference them, so they are NOT actually dead code.
 * DIVIDER_2_Y (WEEKLY/ALL-TIME) is byte-for-byte unchanged from before.
 * DIVIDER_1_Y (Social Points/WEEKLY) is 3.705 - unaffected by this pass,
 * still the same midpoint formula as always.
 */
const DIVIDER_1_Y = (SP_ROW_3_Y + WEEKLY_TITLE_Y) / 2
const DIVIDER_2_Y = (WEEKLY_SHARED_Y + ALLTIME_TITLE_Y) / 2
/**
 * Small, deliberate 0.01-unit standoff from TEXT_LOCAL_Z (-6.6 -> -6.59) -
 * originally sized for the (now-removed) divider planes, kept under this
 * name only because TITLE_PLATE_Z below still reuses this exact value/
 * reasoning for the LEADERBOARD plate's own Z. Renamed from DIVIDER_PLANE_Z
 * to reflect that it's no longer divider-specific - same numeric value,
 * name only, no position change.
 */
const PLANE_STANDOFF_Z = TEXT_LOCAL_Z + 0.01

/**
 * "LEADERBOARD" title plate (PNG, 2172x724, RGBA, aspect ratio exactly 3:1)
 * sitting above TOP SOCIAL QUESTERS - MeshRenderer.setPlane with a real
 * texture + alpha blend (the same plane technique the now-removed divider
 * bars used, with a flat color instead of a texture - see PLANE_STANDOFF_Z's
 * own doc comment).
 *
 * SIZE, round 3 - 0.84x0.28 ("verlo primero") then 1.5x0.5 both still read
 * as too small per explicit follow-up feedback ("se sigue viendo pequeña"),
 * asking for something that reads as "un verdadero encabezado decorativo."
 * Same strategy as before, taken further: SCREEN_TITLE_Y dropped again
 * (5.22 -> 5.02) and the Social Points row gaps compacted further (see
 * SP_TITLE_TO_ROW_GAP/SP_ROW_GAP's own doc comment) to free enough room for
 * a notably bigger plate, while WEEKLY_TITLE_Y stays the same frozen literal
 * it already was - WEEKLY/ALL-TIME still don't move.
 *
 * Budget top-down, from the screen's own usable ceiling (~5.87) to the new
 * SCREEN_TITLE_Y (5.02):
 *   0.03  margin under the ceiling
 *   0.70  plate height (TITLE_PLATE_HEIGHT) - was 0.50
 *   0.12  gap from the plate's own bottom edge to SCREEN_TITLE_Y (unchanged)
 *   ------
 *   0.85  = 5.87 - 5.02, exactly - the whole budget is accounted for.
 * Width 2.1 (up from 1.5, and now inside the ORIGINAL 1.6-1.9 ask's upper
 * end and beyond) at the real 3:1 ratio gives height 0.7 exactly - a 40%
 * area increase over the previous pass. Still comfortably inside TEXT_WIDTH's
 * own 2.6 bound (the screen's real usable width, ~2.71), though with less
 * side margin than before. The 0.12 clearance to SCREEN_TITLE_Y carries over
 * unchanged from the previous pass - still an estimate against the title's
 * Y-CENTER rather than its unmeasurable real visual top edge (TextShape
 * fontSize and a plane's Transform.scale remain different unit systems),
 * worth a specific look in the next Explorer pass.
 */
const TITLE_PLATE_PATH = 'assets/images/leaderboard-3d-title.png'
const TITLE_PLATE_ASPECT_RATIO = 2172 / 724
const TITLE_PLATE_WIDTH = 2.1
const TITLE_PLATE_HEIGHT = TITLE_PLATE_WIDTH / TITLE_PLATE_ASPECT_RATIO
/** Top edge at 5.84 (0.03 under the ~5.87 ceiling), bottom edge at 5.14 (0.12 above the new SCREEN_TITLE_Y of 5.02) - see this constant block's own doc comment for the full top-down budget. */
const TITLE_PLATE_Y = 5.49
/** Same proven text/plane standoff from the screen surface - see PLANE_STANDOFF_Z's own doc comment. */
const TITLE_PLATE_Z = PLANE_STANDOFF_Z

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
 * The small textured "LEADERBOARD" title plate - same parent/rotation
 * convention as every text entity on this sign (parent: panelEntity,
 * rotation: TEXT_ROTATION) - reusing the exact already-proven orientation
 * fix rather than re-deriving one, so the plate faces the viewer correctly
 * and isn't mirrored, same as every TextShape here. Real PNG texture (not a
 * flat diffuseColor - see the now-removed createDividerPlane's own former
 * use of that simpler approach) so its own transparent/soft edges (see
 * TITLE_PLATE_PATH's own doc comment on the asset) render correctly rather
 * than as a hard rectangle.
 *
 * MATERIAL CORRECTION from the original instruction: requested setBasicMaterial
 * (unlit) + transparencyMode: MTM_ALPHA_BLEND together - checked against this
 * SDK's own installed types (PBMaterial_UnlitMaterial, the exact param type
 * setBasicMaterial takes) and transparencyMode is NOT one of its fields; the
 * type comment on FlatMaterial's own transparencyMode is explicit: "(PBR
 * only)". Passing it to setBasicMaterial would fail to compile (excess
 * property on the object literal). MTM_ALPHA_BLEND is required to keep the
 * asset's soft/antialiased edges (the explicit priority here) rather than a
 * hard alphaTest cutout, so this uses setPbrMaterial instead - the only
 * material type that actually exposes transparencyMode. To keep it reading
 * as close to "flat/unlit" as this material type allows without using
 * emissive (explicitly ruled out this pass), metallic/roughness are set to
 * fully matte/non-reflective (0 / 1) - some scene-lighting response is still
 * possible in principle, unlike the genuinely unlit dividers/text, and
 * should be checked in the same Explorer pass as everything else.
 */
function createTitlePlate(parent: Entity): Entity {
    const entity = engine.addEntity()
    Transform.create(entity, {
        parent,
        position: Vector3.create(SCREEN_CENTER_X, TITLE_PLATE_Y, TITLE_PLATE_Z),
        rotation: TEXT_ROTATION,
        scale: Vector3.create(TITLE_PLATE_WIDTH, TITLE_PLATE_HEIGHT, 1)
    })
    MeshRenderer.setPlane(entity)
    Material.setPbrMaterial(entity, {
        texture: Material.Texture.Common({ src: TITLE_PLATE_PATH }),
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
        metallic: 0,
        roughness: 1,
        castShadows: false
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
function createMatchSection(parent: Entity, titleY: number, pairY: number, sharedY: number, titleColor: Color4): MatchSectionEntities {
    return {
        titleText: createTextEntity(parent, SCREEN_CENTER_X, titleY, MATCH_TITLE_FONT_SIZE, titleColor, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH),
        nameA: createTextEntity(parent, PAIR_NAME_A_X, pairY, NAME_FONT_SIZE, MATCH_NAME_COLOR, TextAlignMode.TAM_MIDDLE_RIGHT, PAIR_NAME_WIDTH),
        heart: createTextEntity(parent, PAIR_HEART_X, pairY, MATCH_PAIR_HEART_FONT_SIZE, MATCH_HEART_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, PAIR_HEART_WIDTH),
        nameB: createTextEntity(parent, PAIR_NAME_B_X, pairY, NAME_FONT_SIZE, MATCH_NAME_COLOR, TextAlignMode.TAM_MIDDLE_LEFT, PAIR_NAME_WIDTH),
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

    // Small "LEADERBOARD" plate above the title - see TITLE_PLATE_WIDTH's own
    // doc comment for why it's much smaller than originally requested (the
    // math didn't work at the original size without moving SCREEN_TITLE_Y,
    // which this pass deliberately leaves untouched).
    createTitlePlate(panelEntity)

    // No flanking stars - a previous pass had "✦ TOP SOCIAL QUESTERS ✦"
    // (both stars proven fine in the 2D UI's own Label font, but that's a
    // DIFFERENT font/atlas from 3D TextShape - see this file's own report on
    // the match-section icons removed earlier for the same reason). Removed
    // per explicit feedback that they rendered as missing-glyph squares here
    // too - title is plain centered text now, same color/size/position/align.
    const title = createTextEntity(panelEntity, SCREEN_CENTER_X, SCREEN_TITLE_Y, TITLE_FONT_SIZE, TITLE_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH)

    const spRowYs = [SP_ROW_1_Y, SP_ROW_2_Y, SP_ROW_3_Y]
    const spRows: SocialPointsRowEntities[] = spRowYs.map((rowY, i) => {
        // fontSize now governs rank+SP ONLY - name uses the shared NAME_FONT_SIZE instead (see
        // its own doc comment), so #1's "toque especial" is color alone (gold rank+SP), never a
        // bigger name. Slot i===0 always corresponds to the actual #1 ranked player (response.top
        // is already rank-sorted - see applySocialPoints), so baking this in once at creation is
        // safe regardless of who occupies that rank over time.
        const fontSize = i === 0 ? ROW_FONT_SIZE_FIRST : ROW_FONT_SIZE
        const rankColor = i === 0 ? GOLD : RANK_COLOR
        const spColor = i === 0 ? GOLD : SP_COLOR
        return {
            rank: createTextEntity(panelEntity as Entity, RANK_COLUMN_X, rowY, fontSize, rankColor, TextAlignMode.TAM_MIDDLE_LEFT, RANK_COLUMN_WIDTH),
            name: createTextEntity(panelEntity as Entity, SCREEN_CENTER_X, rowY, NAME_FONT_SIZE, NAME_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, NAME_COLUMN_WIDTH),
            sp: createTextEntity(panelEntity as Entity, SP_COLUMN_X, rowY, fontSize, spColor, TextAlignMode.TAM_MIDDLE_RIGHT, SP_COLUMN_WIDTH)
        }
    })

    // Dash-text divider entity kept structurally at DIVIDER_1_Y (never had visible text even
    // before this pass) - the visible teal divider PLANE that used to sit at this same Y was
    // removed per explicit "quitar completamente las líneas divisorias" instruction. No visual
    // divider exists here anymore - the three sections separate by space/title-color/typography only.
    const dividerAfterSp = createTextEntity(panelEntity, SCREEN_CENTER_X, DIVIDER_1_Y, DIVIDER_FONT_SIZE, DIVIDER_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH, false)

    const weekly = createMatchSection(panelEntity, WEEKLY_TITLE_Y, WEEKLY_PAIR_Y, WEEKLY_SHARED_Y, WEEKLY_TITLE_COLOR)
    setText(weekly.titleText, WEEKLY_TITLE_TEXT)

    // Same treatment as dividerAfterSp above - structural only, no visible divider plane anymore.
    const dividerAfterWeekly = createTextEntity(panelEntity, SCREEN_CENTER_X, DIVIDER_2_Y, DIVIDER_FONT_SIZE, DIVIDER_COLOR, TextAlignMode.TAM_MIDDLE_CENTER, TEXT_WIDTH, false)

    const allTime = createMatchSection(panelEntity, ALLTIME_TITLE_Y, ALLTIME_PAIR_Y, ALLTIME_SHARED_Y, ALLTIME_TITLE_COLOR)
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
