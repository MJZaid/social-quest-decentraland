import ReactEcs, { Label, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { roundManager } from './roundManager'
import { requestLeaderboard, getLatestLeaderboardResponse, LeaderboardResponse } from './leaderboardNetwork'
import { LeaderboardRankedEntry } from './leaderboardRanking'
import { TopMatchesScope } from './topMatchesMessages'
import { requestTopMatches, getTopMatchesResponse, TopMatchesResponse } from './topMatchesNetwork'
import { TopMatchRankedEntry } from './topMatchesRanking'

// -----------------------------------------------------------------------
// LEADERBOARD UI - extracted 1:1 from ui.tsx in an earlier phase (structural
// move, no visual change), reskinned to a Social Quest identity (Phase 2),
// given its own flat "AWARDS / PODIUM / TROPHY BOARD" cream/pink/teal/gold
// identity as a layout-prep pass (Phase 3), and now (Phase 4) wearing the
// first illustrated "kawaii trophy" panel background - same "layout first,
// asset after" order Social Agenda's own redesign followed, now completed.
// Data and logic are untouched: same requestLeaderboard/
// getLatestLeaderboardResponse, same LEADERBOARD_TOP_N, same YOUR RANK
// behavior, same hydrating/ready states, same Top Matches paging/thresholds -
// only colors, sizes, borders and copy markup changed.
//
// Own copies of the small shared color constants rather than importing them
// from ui.tsx - ui.tsx already depends on this file (LeaderboardButton/
// LeaderboardPanel), so importing the reverse direction would make the two
// files circular. CREAM/PINK/MAGENTA/TEAL/MUTED below share the exact same
// numeric values as ui.tsx's own AGENDA_CREAM/AGENDA_PINK/AGENDA_BADGE_
// BACKGROUND/AGENDA_TEAL/CREAM_PANEL_TEXT_MUTED - same "sibling surfaces, no
// cross-file dependency, same values" convention already used for Social
// Agenda. GOLD is genuinely new - the one hue with no Social Agenda
// equivalent, since ranking/achievement is Leaderboard's own identity.
//
// FONT: @dcl/react-ecs's Label only supports `font: 'sans-serif' | 'serif' |
// 'monospace'` - no custom font loading, no fontFamily, no fontWeight exist
// on this component. The "cute" direction is carried entirely by color,
// spacing and borderRadius, not typography.
// -----------------------------------------------------------------------

/** Soft pink - panel border equivalent (now baked into the illustrated asset), hearts, pagination-pill wash, inactive-tab border. Same value as ui.tsx's AGENDA_PINK. */
const PINK = Color4.create(1, 0.75, 0.9, 1)
/** Dark, saturated magenta - primary "on-cream" text and solid-fill active states (active tab, empty-state titles, player names, YOUR RANK label, header close). Same value as ui.tsx's AGENDA_BADGE_BACKGROUND ("Social Quest magenta"). */
const MAGENTA = Color4.create(0.95, 0.2, 0.5, 1)
/** Teal/mint - secondary numeric accent (rank numbers, Social Points figures, Top Matches affinity, active subtab). Same value as ui.tsx's AGENDA_TEAL. Chosen over literal pale PINK for on-cream numeric text specifically where the brief offered a choice "per contrast" - pale pink text reads at very low contrast against the panel's cream fill (both are pastel/light), teal reads clearly. */
const TEAL = Color4.create(0.4, 0.75, 1, 1)
/** Dark, desaturated plum - muted "on-cream" secondary text (shared-answers counts, disabled pagination, loading copy, subtitle lines). Same value as ui.tsx's CREAM_PANEL_TEXT_MUTED. */
const MUTED = Color4.create(0.45, 0.32, 0.4, 1)
/** Controlled ranking/achievement accent - #1 row/pair ONLY (see LeaderboardRow/TopMatchRow), never a panel-wide fill. Deliberately not the same hue as any Social Agenda color - ranking is this panel's own identity. */
const GOLD = Color4.create(0.8, 0.62, 0.22, 1)
/** Very soft, low-alpha wash for the LOCAL PLAYER's own row - teal-based (not gold, not pink) specifically so it can never be confused with the #1 gold treatment or an active/selected pink pill. */
const LOCAL_PLAYER_HIGHLIGHT = Color4.create(TEAL.r, TEAL.g, TEAL.b, 0.18)
/** Very soft gold wash behind the #1 row/pair - "quizá una pequeña highlight suave," never a full card restyle. If the local player IS #1, LOCAL_PLAYER_HIGHLIGHT wins for the row's fill (see LeaderboardRow) so "this is you" still reads as the dominant signal - the gold border/rank-color stays, so #1 is still visible, just not fighting the local-player wash for the same background. */
const GOLD_ROW_HIGHLIGHT = Color4.create(GOLD.r, GOLD.g, GOLD.b, 0.14)
/** Soft pink wash for elements that need to read as a distinct "pill" sitting on top of the illustrated panel's cream interior - pagination buttons only. Alpha halves when disabled, same treatment already proven on Social Agenda's own pagination pills. */
function pillBackground(active: boolean): Color4 {
    return Color4.create(PINK.r, PINK.g, PINK.b, active ? 0.35 : 0.15)
}

/**
 * Illustrated "kawaii trophy" background - SOCIAL AGENDA... no, LEADERBOARD
 * title, trophy, ribbon, side medals and the pink card frame are all baked
 * into this PNG (1448x1086, RGBA, aspect ratio 1448/1086 = 1.3333, i.e. a
 * clean 4:3). textureMode 'stretch' + box dimensions matching this exact
 * ratio, same technique as every other background asset in this file
 * (Social Agenda, gameplay/lobby panel) - never deformed.
 *
 * Sizing derivation (see this task's report for the full pixel-sampled
 * measurement): a pngjs scan of where the cream card is simultaneously free
 * of the trophy/ribbon/title/medals/pink frame found a safe rectangle of
 * ~79% width x ~51% height of the full image (see LEADERBOARD_SAFE_AREA_*
 * below) - decoration here is concentrated almost entirely at the TOP
 * (trophy/ribbon/title/medals), unlike Social Agenda's four-sided
 * decoration, so width is generous but height is the binding constraint.
 *
 * At this task's original ~620/500-wide reference, the CURRENT (pre-this-
 * pass) Top 5 row height/gap could not fit inside the measured safe height
 * at all - not a "bit tight" margin call like Social Agenda, a hard
 * arithmetic shortfall. Given the explicit choice to keep the panel closer
 * to that original reference rather than grow it further, LEADERBOARD_ROW_
 * HEIGHT_WIDE/COMPACT and LEADERBOARD_ROW_GAP (below) were trimmed instead -
 * still comfortably legible, just tighter than before - which is what makes
 * this panel size viable at all. See this task's own report for the exact
 * numbers and the one known remaining edge case (YOUR RANK, addressed in
 * LeaderboardReadyContent's own doc comment).
 */
const LEADERBOARD_PANEL_PATH = 'assets/images/leaderboard-panel-background.png'
const LEADERBOARD_PANEL_ASPECT_RATIO = 1448 / 1086
/** Bumped from 700x525/600x450 per explicit follow-up feedback ("dale un poco más de altura/aire") - same 4:3 ratio exactly (740/555 = 640/480 = 1.3333), still not deformed. The extra real pixels go toward TOP_MATCHES_FIRST_ROW_MARGIN_TOP below, not toward widening TOP_MATCH_ROW_GAP_WIDE/COMPACT again (left exactly as they were). */
const LEADERBOARD_PANEL_WIDTH_WIDE = 740
const LEADERBOARD_PANEL_HEIGHT_WIDE = 555
const LEADERBOARD_PANEL_WIDTH_COMPACT = 640
const LEADERBOARD_PANEL_HEIGHT_COMPACT = 480

/**
 * Safe area for dynamic content - the pixel-sampled cream rectangle
 * described above, expressed as percentages of the panel (scales identically
 * across WIDE/COMPACT). Positioned/sized as an absolute box inside the
 * panel, same pattern as Social Agenda's own AGENDA_SAFE_AREA_*. The baked
 * "LEADERBOARD" title/trophy/ribbon/medals live entirely ABOVE this box (in
 * the top ~40% of the image), never re-rendered here.
 *
 * HEIGHT re-measured and extended 51% -> 53% for the Top Matches spacing
 * pass: a second, more granular pngjs scan (checking the full [140,1300]
 * content-width band, not just a single center column) found the card's
 * rounded bottom corners don't actually start intruding on that band until
 * image y=1013 (previously measured only to ~995-1000 at a coarser step) -
 * a genuine ~23px of clean cream (about +2% of the image height) that was
 * being left on the table, not just internal slack. TOP/LEFT/WIDTH are
 * unchanged (the top decoration boundary and horizontal bounds were never
 * the complaint) - this only grows the box, so Social Points (which shares
 * this same safe area) only ever gets MORE empty room below it, never less.
 */
const LEADERBOARD_SAFE_AREA_LEFT_PERCENT = '10%'
const LEADERBOARD_SAFE_AREA_TOP_PERCENT = '40%'
const LEADERBOARD_SAFE_AREA_WIDTH_PERCENT = '79%'
const LEADERBOARD_SAFE_AREA_HEIGHT_PERCENT = '53%'

/**
 * How many ranked players the Leaderboard overlay requests/shows - fixed,
 * no scroll/pagination in this first version (Phase 2B-3). A deliberately
 * small, controllable number; a later phase can raise it once the panel
 * needs to show more. UNCHANGED this pass - only row height/gap (below)
 * were trimmed to make this same count fit the illustrated panel's safe
 * area, never the count itself.
 */
const LEADERBOARD_TOP_N = 5

/**
 * Fixed per-row height - trimmed from the flat-panel pass's 40/32 down to
 * 32/26 (see LEADERBOARD_PANEL_WIDTH_WIDE's own doc comment for why this was
 * necessary, not optional, to fit Top 5 in the measured safe area at the
 * requested panel size). Still a fixed height, never auto-measured from the
 * Label - same reliability reasoning as ever. Name/SP font sizes (see
 * LeaderboardRow) were trimmed by the same proportion so text still has
 * comfortable clearance inside the shorter row.
 */
const LEADERBOARD_ROW_HEIGHT_WIDE = 32
const LEADERBOARD_ROW_HEIGHT_COMPACT = 26
/** Trimmed from 10 - the sole separation between rows is spacing, not a divider line, and every px here was needed to fit Top 5 in the safe area. SOCIAL POINTS rows (LeaderboardRow) ONLY - Top Matches rows use their own separate TOP_MATCH_ROW_GAP_WIDE/COMPACT below, so a Top Matches rhythm tweak can never touch Social Points' own spacing. */
const LEADERBOARD_ROW_GAP = 6
/**
 * Vertical rhythm for Top Matches rows ONLY (TopMatchRow) - deliberately its
 * own constant, not a reuse of LEADERBOARD_ROW_GAP, precisely so this pass
 * (visual rhythm between matches) can never affect Social Points' rows,
 * which stay byte-for-byte unchanged.
 *
 * Round 1 went 6 -> 8, which per explicit follow-up feedback ("todavía se ve
 * demasiado apretado... el cambio de gap 6->8px NO fue suficiente") wasn't
 * enough of a visible change. Round 2: now tiered by `wide` (previously a
 * single flat value for both tiers) and pushed to the TOP of the requested
 * 12/10 starting range - 14 WIDE / 12 COMPACT - made possible by the
 * LEADERBOARD_SAFE_AREA_HEIGHT_PERCENT extension above (51% -> 53%, ~23px of
 * genuinely re-measured cream, not internal slack) rather than another
 * same-size microcorrection. Pair-to-shared-answers gap within one match
 * stays at 3 (already inside the requested 2-3px range, untouched).
 */
const TOP_MATCH_ROW_GAP_WIDE = 14
const TOP_MATCH_ROW_GAP_COMPACT = 12
/**
 * Extra breathing room between the THIS WEEK/ALL TIME subtab bar (and its
 * underline) and match #1's own pair line - per explicit feedback that #1
 * "casi choca" with the underline. Applied ONCE, as margin-top on the rows
 * container in TopMatchesReadyContent (below), not as a change to
 * TopMatchesSubtabBar's own margin (subtabs are explicitly untouched this
 * pass) and not as another bump to TOP_MATCH_ROW_GAP_WIDE/COMPACT (which
 * governs the gap BETWEEN matches, explicitly left alone this pass - #1 to
 * #2 must look the same as #2 to #3). Same value for both tiers - the
 * requested 8-10px range is small enough that a single number reads fine at
 * both panel sizes.
 */
const TOP_MATCHES_FIRST_ROW_MARGIN_TOP = 10

/** Rounds the current player's row highlight, the #1 gold highlight, and the YOUR RANK callout - self-contained, no adjacent siblings depend on its edges lining up. */
const ROW_HIGHLIGHT_BORDER_RADIUS = 10
/** Thin gold frame on the #1 row/pair only - see GOLD's own doc comment. */
const GOLD_ROW_BORDER_WIDTH = 1

/** Height of one main tab button (SOCIAL POINTS / TOP MATCHES) - unchanged; tabs are the same size as before, only the row/gap sizes below them were trimmed. */
const TAB_HEIGHT = 40
/** Rounds the active tab's own background pill. */
const TAB_BORDER_RADIUS = 10
/** Inactive tab's own pink border - active tabs use a solid MAGENTA fill instead (no border needed, see LeaderboardTabButton). */
const TAB_BORDER_WIDTH = 2
/** Height of one Top Matches subtab button (THIS WEEK / ALL TIME) - deliberately shorter than TAB_HEIGHT so this row reads as a secondary control, never a second main tab bar. */
const SUBTAB_HEIGHT = 30
/** Width/height of the subtle underline mark below an active subtab's label - kept as an underline rather than converted to a pill per the brief's own "puede mantenerse el underline actual" - zero dimension risk. Always rendered, only its color toggles (transparent when inactive) - so switching subtabs never shifts layout. */
const SUBTAB_UNDERLINE_WIDTH = 44
const SUBTAB_UNDERLINE_HEIGHT = 2

/** Small close button size and inset, positioned top-right inside the safe area (absolute, zero flow-layout cost - see LeaderboardPanel's own doc comment for why it wasn't given its own reserved header row). */
const CLOSE_BUTTON_FONT_SIZE = 20
const CLOSE_BUTTON_INSET = 2

/**
 * Which main section of the Leaderboard panel is showing - module-level state,
 * same pattern as leaderboardOpen below (no React hooks in this file). Reset
 * to its default every time the panel is opened (see LeaderboardButton), not
 * when it's closed - so a still-open panel that gets reopened via the HUD
 * button always starts back on SOCIAL POINTS, but a tab switch mid-session is
 * never silently undone by anything else.
 */
type LeaderboardTab = 'socialPoints' | 'topMatches'
let leaderboardTab: LeaderboardTab = 'socialPoints'

/**
 * Which Top Matches ranking is showing - only meaningful while
 * leaderboardTab === 'topMatches', but kept as its own persistent module
 * variable (not reset when leaving the Top Matches tab) so switching back to
 * it remembers the last subtab chosen this session. Reset to its default
 * alongside leaderboardTab on open - see LeaderboardButton. Typed as
 * TopMatchesScope (imported from topMatchesMessages.ts) rather than a
 * separate local union - the two are the exact same concept (which ranking
 * is being asked for), so reusing the network layer's own type keeps them
 * from ever silently drifting apart.
 */
let topMatchesSubtab: TopMatchesScope = 'thisWeek'

/**
 * 0-based page currently requested/shown for whichever scope
 * `topMatchesSubtab` is - reset to 0 whenever the panel opens, the main tab
 * switches to Top Matches, or the subtab changes (see each of those
 * respective onClick/onMouseDown handlers). Read by TopMatchesSection to
 * decide whether the latest network response is still the one to show - see
 * that component's own doc comment.
 */
let topMatchesPage = 0

/** Whether the Leaderboard overlay is open - same role/lifecycle as ui.tsx's own socialAgendaOpen (presentation-only, local, never synced), mutually exclusive with it since both are centered overlays occupying the same screen region. Default: closed. Deliberately not exported directly - see isLeaderboardOpen/openLeaderboard/closeLeaderboard below. */
let leaderboardOpen = false

/** Hover/pressed visual state for LeaderboardButton only - presentation-only, never affects the open/close logic itself. Same pattern as ui.tsx's own socialAgendaButtonHovered/Pressed. */
let leaderboardButtonHovered = false
let leaderboardButtonPressed = false

export function isLeaderboardOpen(): boolean {
    return leaderboardOpen
}

export function openLeaderboard(): void {
    leaderboardOpen = true
}

export function closeLeaderboard(): void {
    leaderboardOpen = false
}

/**
 * Same values/reasoning as ui.tsx's own AGENDA_BUTTON_HIT_AREA_* and
 * AGENDA_BUTTON_ICON_SIZE_* - duplicated for the same "sibling surfaces, no
 * cross-file dependency" reason as the colors above.
 */
const LEADERBOARD_BUTTON_HIT_AREA_WIDE = 72
const LEADERBOARD_BUTTON_HIT_AREA_COMPACT = 64
const LEADERBOARD_BUTTON_ICON_SIZE_WIDE = 60
const LEADERBOARD_BUTTON_ICON_SIZE_HOVER_WIDE = 64
const LEADERBOARD_BUTTON_ICON_SIZE_PRESSED_WIDE = 56
const LEADERBOARD_BUTTON_ICON_SIZE_COMPACT = 52
const LEADERBOARD_BUTTON_ICON_SIZE_HOVER_COMPACT = 56
const LEADERBOARD_BUTTON_ICON_SIZE_PRESSED_COMPACT = 48
const LEADERBOARD_ICON_PATH = 'assets/images/leaderboard-icon.png'

/**
 * Opens the Leaderboard overlay - same fixed-position role in the HUD group
 * as SocialAgendaButton next to it, same ANSWERING/ANSWER LOCKED tap-disable
 * rule. Icon is the final Leaderboard PNG asset - the earlier provisional
 * 3-bar "ranking chart" built from plain rectangles has been retired.
 *
 * A tap requests fresh data every time - no cached-is-good-enough skip - but
 * never clears whatever response is already showing, so a previous result
 * stays visible while the new one is in flight.
 *
 * Unlike SocialAgendaButton, opening this does NOT require `session.joined`
 * (see the leaderboardOpen auto-close rule in uiMenu) - the leaderboard is
 * scene-level social information, not gameplay, so a visitor can check it
 * without ever pressing JOIN.
 *
 * `onOpen` is called right after this panel opens itself - ui.tsx passes a
 * callback that closes the Social Agenda, keeping the two centered overlays
 * mutually exclusive without this file needing to import ui.tsx's own
 * socialAgendaOpen state (which would make the two files circular).
 *
 * Hover/pressed/active are purely visual (see LEADERBOARD_BUTTON_* icon-size
 * constants above), layered on top of the exact same click guard/logic
 * above, never changing what a tap does. `active` mirrors SocialAgendaButton's
 * own open-state treatment in ui.tsx, read directly from this file's own
 * isLeaderboardOpen().
 */
export const LeaderboardButton = ({ wide, onOpen }: { wide: boolean; onOpen: () => void }) => {
    const hitArea = wide ? LEADERBOARD_BUTTON_HIT_AREA_WIDE : LEADERBOARD_BUTTON_HIT_AREA_COMPACT
    const active = leaderboardOpen
    const iconSize = leaderboardButtonPressed
        ? (wide ? LEADERBOARD_BUTTON_ICON_SIZE_PRESSED_WIDE : LEADERBOARD_BUTTON_ICON_SIZE_PRESSED_COMPACT)
        : active || leaderboardButtonHovered
          ? (wide ? LEADERBOARD_BUTTON_ICON_SIZE_HOVER_WIDE : LEADERBOARD_BUTTON_ICON_SIZE_HOVER_COMPACT)
          : (wide ? LEADERBOARD_BUTTON_ICON_SIZE_WIDE : LEADERBOARD_BUTTON_ICON_SIZE_COMPACT)

    return (
        <UiEntity
            uiTransform={{
                width: hitArea,
                height: hitArea,
                justifyContent: 'center',
                alignItems: 'center'
            }}
            onMouseEnter={() => (leaderboardButtonHovered = true)}
            onMouseLeave={() => {
                leaderboardButtonHovered = false
                leaderboardButtonPressed = false // dragging off mid-press shouldn't leave it stuck pressed
            }}
            onMouseDown={() => {
                leaderboardButtonPressed = true
                // Covers ANSWER LOCKED and the pre-round COUNTDOWN too - same reasoning as SocialAgendaButton above.
                const phase = roundManager.getSnapshot().phase
                if (phase === 'answering' || phase === 'countdown') return
                leaderboardTab = 'socialPoints' // always reopen on the default tab - see leaderboardTab's own doc comment
                topMatchesSubtab = 'thisWeek'
                topMatchesPage = 0
                leaderboardOpen = true
                onOpen() // mutually exclusive centered overlays - see this component's own doc comment
                requestLeaderboard(LEADERBOARD_TOP_N) // exactly once per open, never on a tick/timer - Top Matches is requested lazily, only once its tab is actually clicked (see LeaderboardTabButton), never here
            }}
            onMouseUp={() => (leaderboardButtonPressed = false)}
        >
            <UiEntity
                uiTransform={{ width: iconSize, height: iconSize }}
                uiBackground={{ texture: { src: LEADERBOARD_ICON_PATH }, textureMode: 'stretch' }}
            />
        </UiEntity>
    )
}

/**
 * Leaderboard overlay - opened via LeaderboardButton (see uiMenu). Purely a
 * renderer of getLatestLeaderboardResponse()'s current value; builds no
 * ranking/networking logic of its own (see leaderboardNetwork.ts /
 * leaderboardRanking.ts for that). Closing only flips leaderboardOpen -
 * latestLeaderboardResponse is deliberately never cleared, so reopening
 * shows the last known result instantly while a fresh request is in flight
 * (see LeaderboardButton's onMouseDown).
 *
 * Illustrated-panel pass: the flat cream rectangle from the previous phase
 * is replaced by LEADERBOARD_PANEL_PATH (title/trophy/ribbon/medals/frame
 * all baked in) plus the LEADERBOARD_SAFE_AREA_* percentage box for every
 * dynamic element. The old "✦ LEADERBOARD ✦" header row is gone entirely
 * (would duplicate the baked title) - the only header element left is the
 * close "✕", absolutely positioned in the safe area's top-right corner so it
 * costs zero flow-layout height (there was no vertical budget left to spare
 * for a separate reserved header row - see LEADERBOARD_PANEL_WIDTH_WIDE's
 * own doc comment on how tight the fit already is). It sits at the same
 * height as the tab bar's own top-right corner (TOP MATCHES) rather than
 * above it - a minor visual overlap with that pill's own corner, called out
 * explicitly in this task's report for a visual check, not hidden.
 */
export const LeaderboardPanel = ({ wide }: { wide: boolean }) => {
    const response = getLatestLeaderboardResponse()

    const close = () => {
        leaderboardOpen = false
    }

    return (
        <UiEntity
            uiTransform={{
                width: wide ? LEADERBOARD_PANEL_WIDTH_WIDE : LEADERBOARD_PANEL_WIDTH_COMPACT,
                height: wide ? LEADERBOARD_PANEL_HEIGHT_WIDE : LEADERBOARD_PANEL_HEIGHT_COMPACT
            }}
            uiBackground={{ texture: { src: LEADERBOARD_PANEL_PATH }, textureMode: 'stretch' }}
        >
            <UiEntity
                uiTransform={{
                    positionType: 'absolute',
                    position: { top: LEADERBOARD_SAFE_AREA_TOP_PERCENT, left: LEADERBOARD_SAFE_AREA_LEFT_PERCENT },
                    width: LEADERBOARD_SAFE_AREA_WIDTH_PERCENT,
                    height: LEADERBOARD_SAFE_AREA_HEIGHT_PERCENT,
                    flexDirection: 'column'
                }}
            >
                <UiEntity uiTransform={{ positionType: 'absolute', position: { top: CLOSE_BUTTON_INSET, right: CLOSE_BUTTON_INSET }, padding: 6 }} onMouseDown={close}>
                    <Label value="✕" fontSize={CLOSE_BUTTON_FONT_SIZE} color={MAGENTA} />
                </UiEntity>

                <LeaderboardTabBar />

                <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', flexGrow: 1, padding: { top: 12, bottom: 14, left: 16, right: 16 } }}>
                    {leaderboardTab === 'socialPoints' ? (
                        response === null ? (
                            <Label value="Loading leaderboard..." fontSize={16} color={MAGENTA} />
                        ) : response.status === 'hydrating' ? (
                            <Label
                                value="The leaderboard is still starting up. Try again in a few seconds."
                                fontSize={13}
                                textAlign="middle-center"
                                textWrap="wrap"
                                color={MUTED}
                            />
                        ) : (
                            <LeaderboardReadyContent response={response} wide={wide} />
                        )
                    ) : (
                        <TopMatchesSection wide={wide} />
                    )}
                </UiEntity>
            </UiEntity>
        </UiEntity>
    )
}

/**
 * Main section switch (SOCIAL POINTS / TOP MATCHES) - two equal-width tap
 * targets at the top of the safe area. Switching TO Social Points requests
 * nothing (it already has its own fresh data from the panel's own open - see
 * LeaderboardButton). Switching TO Top Matches resets the page to 0 and
 * requests the currently-selected subtab's scope fresh every time this tab
 * is clicked - never lazily "only the first time", so reopening this tab
 * after gameplay has moved on always shows current data, not a stale
 * snapshot from whenever it was last visited. Active tab: solid MAGENTA fill
 * with CREAM text - the same "pink sólido" solid-fill treatment ui.tsx uses
 * for its own selected/active states, chosen over a literal pale-PINK fill
 * because pale pink text-on-pink or cream-on-pale-pink both read at very low
 * contrast (see MAGENTA's own doc comment). Inactive: no fill, PINK border,
 * MAGENTA text - "cute pill" look per the brief.
 */
const LeaderboardTabBar = () => {
    return (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', padding: { top: 2 } }}>
            <LeaderboardTabButton label="SOCIAL POINTS" active={leaderboardTab === 'socialPoints'} onClick={() => (leaderboardTab = 'socialPoints')} />
            <UiEntity uiTransform={{ width: 8 }} />
            <LeaderboardTabButton
                label="TOP MATCHES"
                active={leaderboardTab === 'topMatches'}
                onClick={() => {
                    leaderboardTab = 'topMatches'
                    topMatchesPage = 0
                    requestTopMatches(topMatchesSubtab, topMatchesPage)
                }}
            />
        </UiEntity>
    )
}

/** No hover state added here - LeaderboardTabButton has never had one, and the brief's own hover instruction was explicitly conditional on hover support already existing ("si ya existe soporte actual"). */
const LeaderboardTabButton = ({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) => {
    return (
        <UiEntity
            uiTransform={{
                flexGrow: 1,
                height: TAB_HEIGHT,
                justifyContent: 'center',
                alignItems: 'center',
                borderRadius: TAB_BORDER_RADIUS,
                borderWidth: active ? undefined : TAB_BORDER_WIDTH,
                borderColor: active ? undefined : PINK
            }}
            uiBackground={active ? { color: MAGENTA } : undefined}
            onMouseDown={onClick}
        >
            <Label value={label} fontSize={13} color={active ? Color4.create(0.97, 0.93, 0.86, 1) : MAGENTA} />
        </UiEntity>
    )
}

/**
 * Secondary switch (THIS WEEK / ALL TIME), only rendered while
 * leaderboardTab === 'topMatches'. Deliberately lighter than
 * LeaderboardTabBar above - no background pill, just a color change on the
 * label plus a small underline mark (see SUBTAB_UNDERLINE_WIDTH/HEIGHT) - so
 * this never reads as a second main tab bar, only as a refinement within the
 * already-selected Top Matches section. Kept as an underline (not converted
 * to a pill) per the brief's own "puede mantenerse el underline actual" -
 * zero dimension risk. Clicking either one - even the already-active one -
 * resets the page to 0 and requests that scope fresh, same "always current,
 * never cached-is-good-enough" discipline as the main tab bar and
 * LeaderboardButton.
 */
const TopMatchesSubtabBar = () => {
    const selectSubtab = (scope: TopMatchesScope) => {
        topMatchesSubtab = scope
        topMatchesPage = 0
        requestTopMatches(scope, topMatchesPage)
    }

    // margin-bottom trimmed 8 -> 6: recovers 2px toward TOP_MATCH_ROW_GAP's widened row rhythm, per explicit "reduce ligeramente márgenes vacíos alrededor de subtabs" permission - the subtab bar's own size/style/logic is untouched.
    return (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { bottom: 6 } }}>
            <TopMatchesSubtabButton label="THIS WEEK" active={topMatchesSubtab === 'thisWeek'} onClick={() => selectSubtab('thisWeek')} />
            <UiEntity uiTransform={{ width: 24 }} />
            <TopMatchesSubtabButton label="ALL TIME" active={topMatchesSubtab === 'allTime'} onClick={() => selectSubtab('allTime')} />
        </UiEntity>
    )
}

const TopMatchesSubtabButton = ({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) => {
    return (
        <UiEntity
            uiTransform={{ height: SUBTAB_HEIGHT, flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}
            onMouseDown={onClick}
        >
            <Label value={label} fontSize={12} color={active ? MAGENTA : MUTED} />
            <UiEntity
                uiTransform={{ width: SUBTAB_UNDERLINE_WIDTH, height: SUBTAB_UNDERLINE_HEIGHT, margin: { top: 4 }, borderRadius: 1 }}
                uiBackground={active ? { color: MAGENTA } : undefined}
            />
        </UiEntity>
    )
}

/**
 * Empty state for Top Matches - shown by TopMatchesSection when the current
 * scope's response is confirmed ready but totalPairs === 0. This is a real
 * "nothing eligible yet" result, not a loading state - the manager's own
 * threshold filter (5 shared answers THIS WEEK, 20 ALL TIME) already decided
 * that, and this component never re-checks or duplicates that logic; it only
 * renders the approved copy.
 */
const TopMatchesPlaceholder = ({ subtab }: { subtab: TopMatchesScope }) => {
    const copy =
        subtab === 'thisWeek'
            ? 'Play together this week to discover your best matches.'
            : 'Play together and build connections to discover your best matches.'

    return (
        <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Label value="NO MATCHES YET" fontSize={16} color={MAGENTA} textAlign="middle-center" />
            <UiEntity uiTransform={{ height: 8 }} />
            <Label value={copy} fontSize={13} color={MUTED} textAlign="middle-center" textWrap="wrap" />
        </UiEntity>
    )
}

/**
 * Discreet loading state for Top Matches - covers every "not ready to show
 * rows yet" case at once (no response for this scope/page yet, a scope/page
 * switch still in flight, or the manager's own status:'hydrating').
 * Deliberately the SAME visual weight/tone as Social Points' own hydrating
 * state (MUTED, no spinner/animation) rather than inventing a new loading
 * treatment for this one tab.
 */
const TopMatchesLoading = () => {
    return (
        <UiEntity uiTransform={{ width: '100%', flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Label value="LOADING MATCHES..." fontSize={14} color={MUTED} textAlign="middle-center" />
        </UiEntity>
    )
}

/**
 * Content for the TOP MATCHES tab - the subtab bar is always rendered, then
 * either the loading state, the approved empty placeholder, or ranked rows +
 * footer for the current page. getTopMatchesResponse(scope, page) reads a
 * cache keyed by exactly that pair - this panel only ever reads its OWN
 * (topMatchesSubtab, topMatchesPage) entry, which leaderboardDisplay3D.ts's
 * independent periodic requests can never overwrite (separate cache keys).
 * The out-of-range-page correction below can only ever fire once per stale
 * response, never every frame - see the previous phase's own doc comment on
 * this same logic, unchanged.
 */
const TopMatchesSection = ({ wide }: { wide: boolean }) => {
    const response = getTopMatchesResponse(topMatchesSubtab, topMatchesPage)

    if (response !== null && response.status === 'ready') {
        const totalPages = Math.max(1, Math.ceil(response.totalPairs / response.pageSize))
        if (topMatchesPage > totalPages - 1) {
            topMatchesPage = totalPages - 1
            requestTopMatches(topMatchesSubtab, topMatchesPage)
        } else {
            return (
                <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', flexGrow: 1 }}>
                    <TopMatchesSubtabBar />
                    {response.totalPairs === 0 ? (
                        <TopMatchesPlaceholder subtab={topMatchesSubtab} />
                    ) : (
                        <TopMatchesReadyContent response={response} totalPages={totalPages} wide={wide} />
                    )}
                </UiEntity>
            )
        }
    }

    return (
        <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', flexGrow: 1 }}>
            <TopMatchesSubtabBar />
            <TopMatchesLoading />
        </UiEntity>
    )
}

/**
 * The current page's ranked rows plus an optional PREV/1-of-N/NEXT footer -
 * only reached once TopMatchesSection has already confirmed the response
 * matches the current scope/page and totalPairs > 0. `totalPages` is passed
 * in rather than recomputed here - already derived once by the caller from
 * this same response, no reason to compute it twice.
 */
const TopMatchesReadyContent = ({ response, totalPages, wide }: { response: TopMatchesResponse; totalPages: number; wide: boolean }) => {
    return (
        // margin-top: TOP_MATCHES_FIRST_ROW_MARGIN_TOP - the gap between the subtab bar above (rendered by the caller, TopMatchesSection) and match #1 below. Does not touch TOP_MATCH_ROW_GAP_WIDE/COMPACT (the #1-to-#2, #2-to-#3, ... rhythm), which stays exactly as it was.
        <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', margin: { top: TOP_MATCHES_FIRST_ROW_MARGIN_TOP } }}>
            {response.rows.map((entry) => (
                <UiEntity key={entry.pairKey} uiTransform={{ width: '100%' }}>
                    <TopMatchRow entry={entry} wide={wide} />
                </UiEntity>
            ))}
            {totalPages > 1 && (
                <TopMatchesFooter
                    page={response.page}
                    totalPages={totalPages}
                    onPrev={() => {
                        topMatchesPage = response.page - 1
                        requestTopMatches(topMatchesSubtab, topMatchesPage)
                    }}
                    onNext={() => {
                        topMatchesPage = response.page + 1
                        requestTopMatches(topMatchesSubtab, topMatchesPage)
                    }}
                />
            )}
        </UiEntity>
    )
}

/**
 * PREV / page-of-total / NEXT - same small rounded cream/pink pill
 * pagination already proven on Social Agenda (soft pink wash that
 * strengthens when enabled, dims to muted when disabled). No wrap-around, no
 * logic change - `page` is 0-based internally; the visible counter is
 * always 1-based.
 */
const TopMatchesFooter = ({ page, totalPages, onPrev, onNext }: { page: number; totalPages: number; onPrev: () => void; onNext: () => void }) => {
    const canGoPrevious = page > 0
    const canGoNext = page < totalPages - 1

    return (
        // margin-top restored to 10 (was trimmed to 8 in the first spacing pass, no longer needed now that LEADERBOARD_SAFE_AREA_HEIGHT_PERCENT was extended) - PREV/NEXT's own size/style/logic is untouched, this is purely its distance from the last match row above it.
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', margin: { top: 10 } }}>
            <UiEntity
                uiTransform={{ padding: { top: 6, bottom: 6, left: 12, right: 12 }, borderRadius: 12 }}
                uiBackground={{ color: pillBackground(canGoPrevious) }}
                onMouseDown={() => {
                    if (canGoPrevious) onPrev()
                }}
            >
                <Label value="PREV" fontSize={12} color={canGoPrevious ? MAGENTA : MUTED} />
            </UiEntity>
            <Label value={`${page + 1} / ${totalPages}`} fontSize={12} color={MUTED} />
            <UiEntity
                uiTransform={{ padding: { top: 6, bottom: 6, left: 12, right: 12 }, borderRadius: 12 }}
                uiBackground={{ color: pillBackground(canGoNext) }}
                onMouseDown={() => {
                    if (canGoNext) onNext()
                }}
            >
                <Label value="NEXT" fontSize={12} color={canGoNext ? MAGENTA : MUTED} />
            </UiEntity>
        </UiEntity>
    )
}

/**
 * One ranked pair: rank + both display names joined by a small heart on the
 * first line, affinity percentage at the far right; shared-answers count on
 * a second, indented line underneath. `entry.displayNameA`/`displayNameB`
 * and `entry.affinity`/`entry.sharedValidAnswers` all come straight from
 * TopMatchRankedEntry (topMatchesRanking.ts) - no recomputation. Rank #1
 * gets the same restrained gold treatment as LeaderboardRow's own top-of-
 * board row (gold rank color only - no card restyle, no size change), per
 * the brief's explicit "no hacer que #1 tenga una card completamente
 * diferente." Ranks 2+ use TEAL for the rank number rather than a literal
 * pale PINK (offered as an option in the brief) for the same on-cream
 * contrast reason as LeaderboardRow's own rank column. Names: MAGENTA. Heart:
 * PINK (soft, decorative, not information-bearing so the same contrast rule
 * doesn't apply). Affinity: TEAL, per explicit instruction. Shared answers:
 * MUTED, per explicit instruction.
 */
const TopMatchRow = ({ entry, wide }: { entry: TopMatchRankedEntry; wide: boolean }) => {
    const sharedLabel = `${entry.sharedValidAnswers} SHARED ANSWER${entry.sharedValidAnswers === 1 ? '' : 'S'}`
    const isTopRank = entry.rank === 1
    const rankColor = isTopRank ? GOLD : TEAL

    return (
        <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', margin: { bottom: wide ? TOP_MATCH_ROW_GAP_WIDE : TOP_MATCH_ROW_GAP_COMPACT } }}>
            <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Label value={`#${entry.rank}`} fontSize={wide ? 14 : 12} color={rankColor} />
                    <UiEntity uiTransform={{ width: wide ? 8 : 6 }} />
                    <Label value={entry.displayNameA} fontSize={wide ? 15 : 13} color={MAGENTA} />
                    <UiEntity uiTransform={{ width: 5 }} />
                    <Label value="♥" fontSize={wide ? 13 : 11} color={PINK} />
                    <UiEntity uiTransform={{ width: 5 }} />
                    <Label value={entry.displayNameB} fontSize={wide ? 15 : 13} color={MAGENTA} />
                </UiEntity>
                <Label value={`${Math.round(entry.affinity)}%`} fontSize={wide ? 15 : 13} color={TEAL} />
            </UiEntity>
            <Label
                value={sharedLabel}
                fontSize={wide ? 11 : 10}
                color={MUTED}
                uiTransform={{ margin: { top: 3, left: wide ? 28 : 24 } }}
            />
        </UiEntity>
    )
}

/**
 * `response.status === 'ready'` content only - split out from LeaderboardPanel
 * purely so that branch doesn't need an inline cast. `me` is matched against
 * `top` strictly by userId (never displayName, never rank) - see
 * meAlreadyInTop below - since displayName can collide (two "Questmate"
 * fallbacks) and rank is exactly the value being compared against.
 *
 * KNOWN LIMITATION at this panel size (see LEADERBOARD_PANEL_WIDTH_WIDE's
 * own doc comment): the YOUR RANK block below is sized/spaced as tightly as
 * the rest of this pass, but Top 5 + YOUR RANK together still exceed the
 * measured safe area's height at the panel size this task's own follow-up
 * chose (closer to the original ~620/500 reference over a larger, guaranteed-
 * fit panel). When the local player is NOT in the visible Top 5, expect this
 * block to extend past the safe cream zone toward the bottom pink frame -
 * flagged explicitly in this task's report for visual QA, not hidden.
 */
const LeaderboardReadyContent = ({ response, wide }: { response: LeaderboardResponse; wide: boolean }) => {
    const { top, me } = response
    const meAlreadyInTop = me !== null && top.some((entry) => entry.userId === me.userId)

    return (
        <UiEntity uiTransform={{ flexDirection: 'column', width: '100%' }}>
            {top.length === 0 ? (
                <Label value="No players ranked yet." fontSize={14} color={MAGENTA} />
            ) : (
                top.map((entry) => (
                    <UiEntity key={entry.userId} uiTransform={{ width: '100%' }}>
                        <LeaderboardRow entry={entry} highlighted={me !== null && entry.userId === me.userId} wide={wide} />
                    </UiEntity>
                ))
            )}

            {me === null ? (
                <UiEntity uiTransform={{ margin: { top: 10 } }}>
                    <Label value="You haven't made progress yet." fontSize={14} color={MAGENTA} />
                </UiEntity>
            ) : !meAlreadyInTop ? (
                <UiEntity
                    uiTransform={{
                        flexDirection: 'column',
                        width: '100%',
                        margin: { top: 6 },
                        padding: 5,
                        borderRadius: ROW_HIGHLIGHT_BORDER_RADIUS,
                        borderWidth: 1,
                        borderColor: TEAL
                    }}
                >
                    <Label value="YOUR RANK" fontSize={11} color={MAGENTA} uiTransform={{ margin: { bottom: 2 } }} />
                    <LeaderboardRow entry={me} highlighted={true} wide={wide} />
                </UiEntity>
            ) : null}
        </UiEntity>
    )
}

/**
 * One ranked row: rank + name on the left; Social Points on the right.
 * `highlighted` marks the local player's own row (by userId match only - see
 * LeaderboardReadyContent) with a soft teal/mint wash (LOCAL_PLAYER_HIGHLIGHT) -
 * deliberately teal, not gold or pink, so it reads as "this is you" and can
 * never be confused with the #1 gold treatment below or an active/selected
 * pink pill elsewhere in this panel.
 *
 * Rank #1 gets a restrained gold accent - gold rank color, a thin gold
 * border, and (only when this row is NOT also the local player's own row) a
 * very soft gold background wash. If the local player IS #1, the teal
 * LOCAL_PLAYER_HIGHLIGHT wins the row's fill instead, so "this is you" stays
 * the dominant visual signal - the gold border and gold "#1" text still show,
 * so the rank is still clearly readable, just not fighting the local-player
 * wash for the same background. No size change, no separate card - per the
 * brief's explicit "no hacer que #1 tenga una card completamente diferente
 * ni gigantesca."
 *
 * Name: MAGENTA. SP figure: TEAL, not the literal pale PINK the brief
 * offered as an alternative - see TEAL's own doc comment for the on-cream
 * contrast reasoning. `entry.socialPoints` is still the Social Points v2
 * total (validRounds + friendshipBonusPoints, getTotalSocialPoints) -
 * untouched. Row height/gap and name/SP font sizes trimmed from the previous
 * pass - see LEADERBOARD_ROW_HEIGHT_WIDE's own doc comment for why.
 */
const LeaderboardRow = ({ entry, highlighted, wide }: { entry: LeaderboardRankedEntry; highlighted: boolean; wide: boolean }) => {
    const rowHeight = wide ? LEADERBOARD_ROW_HEIGHT_WIDE : LEADERBOARD_ROW_HEIGHT_COMPACT
    const isTopRank = entry.rank === 1
    const rankColor = isTopRank ? GOLD : TEAL

    return (
        <UiEntity
            uiTransform={{
                width: '100%',
                height: rowHeight,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: { left: 8, right: 8 },
                margin: { bottom: LEADERBOARD_ROW_GAP },
                borderRadius: highlighted || isTopRank ? ROW_HIGHLIGHT_BORDER_RADIUS : undefined,
                borderWidth: isTopRank ? GOLD_ROW_BORDER_WIDTH : undefined,
                borderColor: isTopRank ? GOLD : undefined
            }}
            uiBackground={highlighted ? { color: LOCAL_PLAYER_HIGHLIGHT } : isTopRank ? { color: GOLD_ROW_HIGHLIGHT } : undefined}
        >
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <Label value={`#${entry.rank}`} fontSize={wide ? 14 : 12} color={rankColor} />
                <UiEntity uiTransform={{ width: wide ? 8 : 6 }} />
                <Label value={entry.displayName} fontSize={wide ? 17 : 14} color={MAGENTA} />
            </UiEntity>
            <Label value={`${entry.socialPoints} SP`} fontSize={wide ? 16 : 13} color={TEAL} />
        </UiEntity>
    )
}
