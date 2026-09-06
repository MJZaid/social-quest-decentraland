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
// move, no visual change), now carrying its OWN Social Quest visual identity
// (Phase 2) - dark translucent, cream/pink/teal, no yellow/purple. Data and
// logic are untouched: same requestLeaderboard/getLatestLeaderboardResponse,
// same LEADERBOARD_TOP_N, same YOUR RANK behavior, same hydrating/ready
// states - only colors, sizes, spacing and copy markup changed.
//
// Own copies of the small shared constants (PANEL_BACKGROUND/MUTED/button
// size) rather than importing them from ui.tsx - ui.tsx already depends on
// this file (LeaderboardButton/LeaderboardPanel), so importing the reverse
// direction would make the two files circular. See this file's own history
// for why PANEL_BACKGROUND/MUTED keep the exact same values ui.tsx still
// uses elsewhere - only the Leaderboard-exclusive colors (CREAM/SOCIAL_PINK/
// TEAL_ACCENT/ROW_HIGHLIGHT below) are new to this redesign.
//
// FONT: @dcl/react-ecs's Label only supports `font: 'sans-serif' | 'serif' |
// 'monospace'` - no custom font loading, no fontFamily, no fontWeight exist
// on this component (verified against the installed package's own type
// definitions and the build-ui skill's Label reference). Fredoka/Nunito/
// Quicksand are therefore not achievable here - 'sans-serif' (the default,
// already used everywhere in this file) is the only genuinely rounded/neutral
// option among the three, so the "cute" direction is carried entirely by
// color, spacing and borderRadius instead of typography.
// -----------------------------------------------------------------------

const MUTED = Color4.create(0.7, 0.7, 0.75, 1)
const PANEL_BACKGROUND = Color4.create(0.05, 0.05, 0.1, 0.85)

/** Warm off-white for titles and player names - the one genuinely new color this redesign introduces (no existing "cream" constant existed anywhere in ui.tsx to reuse). Deliberately not pure white - a touch warmer, per the "cute, not clinical" direction. */
const CREAM = Color4.create(0.97, 0.93, 0.86, 1)
/** Social Quest's own pink - reused verbatim from ui.tsx's existing Affinity label color (Social Agenda), not invented here. Used for Social Points values, the header's small accent, the close button, and the current-player row highlight. */
const SOCIAL_PINK = Color4.create(1, 0.75, 0.9, 1)
/** Very low-alpha version of SOCIAL_PINK for the current player's row - replaces the old strong purple tint (0.6, 0.45, 0.85, 0.35) with a genuinely subtle highlight, per the "MUY sutil" direction. */
const ROW_HIGHLIGHT = Color4.create(1, 0.75, 0.9, 0.12)
/** Secondary accent - reused verbatim from ui.tsx's existing Friendship-level line color (Social Agenda), not invented here. Used sparingly, only for the rank number, so it never competes with the name (cream) or Social Points (pink). */
const TEAL_ACCENT = Color4.create(0.4, 0.75, 1, 1)

/**
 * Same values/reasoning as ui.tsx's own AGENDA_BUTTON_HIT_AREA_* and
 * AGENDA_BUTTON_ICON_SIZE_* - duplicated for the same "sibling surfaces, no
 * cross-file dependency" reason as CREAM/SOCIAL_PINK/TEAL_ACCENT above. See
 * ui.tsx's own copy of this comment for the full reasoning (no background/
 * border/box, separate invisible hit area vs. visual icon size, state
 * feedback expressed purely through icon size since this SDK has no real
 * glow/shadow/blur capability) - identical here.
 */
const LEADERBOARD_BUTTON_HIT_AREA_WIDE = 64
const LEADERBOARD_BUTTON_HIT_AREA_COMPACT = 56
const LEADERBOARD_BUTTON_ICON_SIZE_WIDE = 50
const LEADERBOARD_BUTTON_ICON_SIZE_HOVER_WIDE = 54
const LEADERBOARD_BUTTON_ICON_SIZE_PRESSED_WIDE = 46
const LEADERBOARD_BUTTON_ICON_SIZE_COMPACT = 44
const LEADERBOARD_BUTTON_ICON_SIZE_HOVER_COMPACT = 48
const LEADERBOARD_BUTTON_ICON_SIZE_PRESSED_COMPACT = 40
const LEADERBOARD_ICON_PATH = 'assets/images/leaderboard-icon.png'

/**
 * How many ranked players the Leaderboard overlay requests/shows - fixed,
 * no scroll/pagination in this first version (Phase 2B-3). A deliberately
 * small, controllable number; a later phase can raise it once the panel
 * needs to show more.
 */
const LEADERBOARD_TOP_N = 5

/** Leaderboard overlay panel width - the pre-approved future dimensions (560/420), applied now so the panel doesn't visibly resize later when tabs are added. Still deliberately narrower than the Social Agenda panel - its content remains a short, fixed-length list. */
const LEADERBOARD_WIDTH_WIDE = 560
const LEADERBOARD_WIDTH_COMPACT = 420

/** Fixed per-row height - taller than before (was 32/26) for more vertical air per row, same reliability reasoning as ever: a row's height is never left to auto-measure from its Label. */
const LEADERBOARD_ROW_HEIGHT_WIDE = 40
const LEADERBOARD_ROW_HEIGHT_COMPACT = 32
/** Wider than before (was 6) - the sole separation between rows is now spacing, not a divider line, per the "avoid boxes/thick borders" direction. */
const LEADERBOARD_ROW_GAP = 10

/**
 * Minimum height for the content area below the header - sized to
 * comfortably fit LEADERBOARD_TOP_N rows plus the optional YOUR RANK block,
 * so today's short states (0 players, hydrating) don't look tiny next to a
 * full one, and so the panel doesn't visibly jump in height once tabs are
 * added later (each tab's content will sit inside this same stable zone).
 * Deliberately a minHeight, not a fixed height - a longer future ranking
 * (more rows once pagination exists) can still grow past it.
 */
const LEADERBOARD_CONTENT_MIN_HEIGHT_WIDE = 320
const LEADERBOARD_CONTENT_MIN_HEIGHT_COMPACT = 280

/** Rounds the whole panel's silhouette - modest, not a "boxes within boxes" look, just enough to read as soft/modern. The header below matches this on its own top corners only (see HEADER_BORDER_RADIUS) so its opaque background doesn't visually square off the panel's rounded top. */
const PANEL_BORDER_RADIUS = 20
const HEADER_BORDER_RADIUS = { topLeft: PANEL_BORDER_RADIUS, topRight: PANEL_BORDER_RADIUS }
/** Small radius on the current player's row highlight only - self-contained, no adjacent siblings depend on its edges lining up, so no seam risk like the panel/header pairing above. */
const ROW_HIGHLIGHT_BORDER_RADIUS = 10

/** Height of one main tab button (SOCIAL POINTS / TOP MATCHES). */
const TAB_HEIGHT = 40
/** Rounds the active tab's own background pill - independent of PANEL_BORDER_RADIUS, this is a small self-contained shape with no adjacent seam to line up with. */
const TAB_BORDER_RADIUS = 10
/** Height of one Top Matches subtab button (THIS WEEK / ALL TIME) - deliberately shorter than TAB_HEIGHT so this row reads as a secondary control, never a second main tab bar. Tall enough to fit its label plus the small active-underline below it (see SUBTAB_UNDERLINE_HEIGHT). */
const SUBTAB_HEIGHT = 30
/** Width/height of the subtle underline mark below an active subtab's label - the ONLY thing that distinguishes active from inactive here besides the label's own color (see TopMatchesSubtabButton). Always rendered, only its color toggles (transparent when inactive) - so switching subtabs never shifts layout. Deliberately not a real border (uiTransform's borderWidth/borderColor apply to all four sides at once, with no per-side control in this SDK) - a small separate rectangle achieves the same "underline" look without that limitation. */
const SUBTAB_UNDERLINE_WIDTH = 44
const SUBTAB_UNDERLINE_HEIGHT = 2

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
 */
export const LeaderboardPanel = ({ wide }: { wide: boolean }) => {
    const response = getLatestLeaderboardResponse()

    const close = () => {
        leaderboardOpen = false
    }

    return (
        <UiEntity
            uiTransform={{ flexDirection: 'column', width: wide ? LEADERBOARD_WIDTH_WIDE : LEADERBOARD_WIDTH_COMPACT, borderRadius: PANEL_BORDER_RADIUS }}
            uiBackground={{ color: PANEL_BACKGROUND }}
        >
            {/* Header is the whole-row tap target to close - same proven pattern as the Social Agenda's own header. Top corners match the panel's own radius (see HEADER_BORDER_RADIUS) so this opaque rectangle doesn't square off the panel's rounded top. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: { top: 18, bottom: 18, left: 20, right: 20 },
                    borderRadius: HEADER_BORDER_RADIUS
                }}
                uiBackground={{ color: PANEL_BACKGROUND }}
                onMouseDown={close}
            >
                {/* "✦ LEADERBOARD ✦" - the star is the same glyph already validated in production (see LeaderboardButton), reused rather than introducing new decorative Unicode. Cream title with a small pink accent on the stars, replacing the old solid yellow. */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Label value="✦" fontSize={18} color={SOCIAL_PINK} />
                    <UiEntity uiTransform={{ width: 10 }} />
                    <Label value="LEADERBOARD" fontSize={22} color={CREAM} />
                    <UiEntity uiTransform={{ width: 10 }} />
                    <Label value="✦" fontSize={18} color={SOCIAL_PINK} />
                </UiEntity>
                <Label value="✕" fontSize={22} color={SOCIAL_PINK} />
            </UiEntity>

            <LeaderboardTabBar />

            <UiEntity
                uiTransform={{
                    flexDirection: 'column',
                    width: '100%',
                    minHeight: wide ? LEADERBOARD_CONTENT_MIN_HEIGHT_WIDE : LEADERBOARD_CONTENT_MIN_HEIGHT_COMPACT,
                    padding: { top: 16, bottom: 20, left: 20, right: 20 }
                }}
            >
                {leaderboardTab === 'socialPoints' ? (
                    response === null ? (
                        <Label value="Loading leaderboard..." fontSize={18} color={MUTED} />
                    ) : response.status === 'hydrating' ? (
                        <Label
                            value="The leaderboard is still starting up. Try again in a few seconds."
                            fontSize={16}
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
    )
}

/**
 * Main section switch (SOCIAL POINTS / TOP MATCHES) - two equal-width tap
 * targets below the header, above the stable content zone (see
 * LEADERBOARD_CONTENT_MIN_HEIGHT_WIDE/COMPACT). Switching TO Social Points
 * requests nothing (it already has its own fresh data from the panel's own
 * open - see LeaderboardButton). Switching TO Top Matches resets the page to
 * 0 and requests the currently-selected subtab's scope fresh every time this
 * tab is clicked - never lazily "only the first time", so reopening this tab
 * after gameplay has moved on always shows current data, not a stale
 * snapshot from whenever it was last visited. Active tab: a subtle pink pill
 * (ROW_HIGHLIGHT - same color already used for the current player's row,
 * reused rather than inventing a new one) with cream text. Inactive: no
 * background, muted text.
 */
const LeaderboardTabBar = () => {
    return (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', padding: { top: 4, left: 20, right: 20 } }}>
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

const LeaderboardTabButton = ({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) => {
    return (
        <UiEntity
            uiTransform={{
                flexGrow: 1,
                height: TAB_HEIGHT,
                justifyContent: 'center',
                alignItems: 'center',
                borderRadius: active ? TAB_BORDER_RADIUS : undefined
            }}
            uiBackground={active ? { color: ROW_HIGHLIGHT } : undefined}
            onMouseDown={onClick}
        >
            <Label value={label} fontSize={14} color={active ? CREAM : MUTED} />
        </UiEntity>
    )
}

/**
 * Secondary switch (THIS WEEK / ALL TIME), only rendered while
 * leaderboardTab === 'topMatches'. Deliberately lighter than
 * LeaderboardTabBar above - no background pill, just a color change on the
 * label plus a small underline mark (see SUBTAB_UNDERLINE_WIDTH/HEIGHT) - so
 * this never reads as a second main tab bar, only as a refinement within the
 * already-selected Top Matches section. Clicking either one - even the
 * already-active one - resets the page to 0 and requests that scope fresh,
 * same "always current, never cached-is-good-enough" discipline as the main
 * tab bar and LeaderboardButton.
 */
const TopMatchesSubtabBar = () => {
    const selectSubtab = (scope: TopMatchesScope) => {
        topMatchesSubtab = scope
        topMatchesPage = 0
        requestTopMatches(scope, topMatchesPage)
    }

    return (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { bottom: 10 } }}>
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
            <Label value={label} fontSize={13} color={active ? SOCIAL_PINK : MUTED} />
            <UiEntity
                uiTransform={{ width: SUBTAB_UNDERLINE_WIDTH, height: SUBTAB_UNDERLINE_HEIGHT, margin: { top: 4 }, borderRadius: 1 }}
                uiBackground={active ? { color: SOCIAL_PINK } : undefined}
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
 * renders the approved copy. One title line (cream, larger) plus one muted
 * secondary line - nothing else. No "TOP MATCHES — ..." repeated here on
 * purpose: the active main tab and subtab already say that, so this only
 * needs to say what's currently empty and why.
 *
 * The bottom margin on the copy line is a deliberate centering trick, not
 * spacing for its own sake: this whole block is vertically centered by its
 * parent's justifyContent:'center' (see the return below), so padding added
 * only at the bottom of the group shifts its visual center upward by half
 * that amount - a ~12px lift, so it reads less "dead center, low" and more
 * naturally aligned with the tabs above it.
 */
const TopMatchesPlaceholder = ({ subtab }: { subtab: TopMatchesScope }) => {
    const copy =
        subtab === 'thisWeek'
            ? 'Play together this week to discover your best matches.'
            : 'Play together and build connections to discover your best matches.'

    return (
        <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Label value="NO MATCHES YET" fontSize={18} color={CREAM} textAlign="middle-center" />
            <UiEntity uiTransform={{ height: 10 }} />
            <Label value={copy} fontSize={15} color={MUTED} textAlign="middle-center" textWrap="wrap" uiTransform={{ margin: { bottom: 26 } }} />
        </UiEntity>
    )
}

/**
 * Discreet loading state for Top Matches - covers every "not ready to show
 * rows yet" case at once (no response for this scope/page yet, a scope/page
 * switch still in flight, or the manager's own status:'hydrating') per this
 * phase's own "show loading, never stale data from another scope" direction.
 * Deliberately the SAME visual weight/tone as Social Points' own "Loading
 * leaderboard..." state (MUTED, no spinner/animation) rather than inventing a
 * new loading treatment for this one tab.
 */
const TopMatchesLoading = () => {
    return (
        <UiEntity uiTransform={{ width: '100%', flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Label value="LOADING MATCHES..." fontSize={16} color={MUTED} textAlign="middle-center" />
        </UiEntity>
    )
}

/**
 * Content for the TOP MATCHES tab - the subtab bar is always rendered, then
 * either the loading state, the approved empty placeholder, or ranked rows +
 * footer for the current page.
 *
 * getTopMatchesResponse(scope, page) reads a cache keyed by exactly that pair
 * (see topMatchesNetwork.ts's own doc comment) - this panel only ever reads
 * its OWN (topMatchesSubtab, topMatchesPage) entry, which leaderboardDisplay3D.ts's
 * independent periodic requests (always thisWeek/allTime page 0) can never
 * overwrite, since they write to their own separate cache keys. A null read
 * (nothing cached yet for this exact scope/page) falls back to the loading
 * state - this is what guarantees a THIS WEEK response can never flash under
 * ALL TIME (or vice versa), and that changing page never shows the previous
 * page's rows for even one frame.
 *
 * The one exception is the out-of-range-page correction: if the response for
 * this exact scope/page reports a page beyond what its totalPairs actually
 * supports (the ranking shrank while sitting on a deeper page), this clamps
 * topMatchesPage down and re-requests - but that mutation immediately makes
 * this component look up a DIFFERENT cache key for every subsequent frame
 * until the corrected response arrives, so this branch can only ever fire
 * once per stale response, never every frame - there is no separate guard
 * variable needed for that.
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
        <UiEntity uiTransform={{ flexDirection: 'column', width: '100%' }}>
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
 * PREV / page-of-total / NEXT - same visual pattern as ui.tsx's own Social
 * Agenda pagination footer (PANEL_BACKGROUND-tinted tap targets, no
 * wrap-around, disabled state just dims the label rather than hiding the
 * button), reused here rather than inventing a new pagination look. `page`
 * is 0-based internally; the visible counter is always 1-based.
 */
const TopMatchesFooter = ({ page, totalPages, onPrev, onNext }: { page: number; totalPages: number; onPrev: () => void; onNext: () => void }) => {
    const canGoPrevious = page > 0
    const canGoNext = page < totalPages - 1

    return (
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', margin: { top: 14 } }}>
            <UiEntity
                uiTransform={{ padding: { top: 8, bottom: 8, left: 14, right: 14 }, borderRadius: 8 }}
                uiBackground={{ color: PANEL_BACKGROUND }}
                onMouseDown={() => {
                    if (canGoPrevious) onPrev()
                }}
            >
                <Label value="PREV" fontSize={14} color={canGoPrevious ? CREAM : MUTED} />
            </UiEntity>
            <Label value={`${page + 1} / ${totalPages}`} fontSize={14} color={MUTED} />
            <UiEntity
                uiTransform={{ padding: { top: 8, bottom: 8, left: 14, right: 14 }, borderRadius: 8 }}
                uiBackground={{ color: PANEL_BACKGROUND }}
                onMouseDown={() => {
                    if (canGoNext) onNext()
                }}
            >
                <Label value="NEXT" fontSize={14} color={canGoNext ? CREAM : MUTED} />
            </UiEntity>
        </UiEntity>
    )
}

/**
 * One ranked pair: rank (teal) + both display names (cream) joined by a
 * small pink heart on the first line, affinity percentage (pink) at the far
 * right; shared-answers count (muted) on a second, indented line underneath.
 * `entry.displayNameA`/`displayNameB` and `entry.affinity`/
 * `entry.sharedValidAnswers` all come straight from TopMatchRankedEntry
 * (topMatchesRanking.ts) - no recomputation, no separate name-resolution
 * system; `Math.round` here is presentation-only rounding of the already-
 * derived percentage, the same rounding ui.tsx's own affinityLabel already
 * applies to the identical value in Social Agenda, not a second formula.
 * "♥" rather than a color emoji heart - a plain BMP dingbat glyph, the same
 * class of Unicode symbol as the already-proven "✦" used elsewhere in this
 * file, avoiding this SDK's inconsistent full-color-emoji glyph support.
 */
const TopMatchRow = ({ entry, wide }: { entry: TopMatchRankedEntry; wide: boolean }) => {
    const sharedLabel = `${entry.sharedValidAnswers} SHARED ANSWER${entry.sharedValidAnswers === 1 ? '' : 'S'}`

    return (
        <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', margin: { bottom: LEADERBOARD_ROW_GAP } }}>
            <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Label value={`#${entry.rank}`} fontSize={wide ? 16 : 14} color={TEAL_ACCENT} />
                    <UiEntity uiTransform={{ width: wide ? 10 : 8 }} />
                    <Label value={entry.displayNameA} fontSize={wide ? 18 : 15} color={CREAM} />
                    <UiEntity uiTransform={{ width: 6 }} />
                    <Label value="♥" fontSize={wide ? 15 : 13} color={SOCIAL_PINK} />
                    <UiEntity uiTransform={{ width: 6 }} />
                    <Label value={entry.displayNameB} fontSize={wide ? 18 : 15} color={CREAM} />
                </UiEntity>
                <Label value={`${Math.round(entry.affinity)}%`} fontSize={wide ? 18 : 15} color={SOCIAL_PINK} />
            </UiEntity>
            <Label
                value={sharedLabel}
                fontSize={wide ? 13 : 11}
                color={MUTED}
                uiTransform={{ margin: { top: 4, left: wide ? 34 : 30 } }}
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
 */
const LeaderboardReadyContent = ({ response, wide }: { response: LeaderboardResponse; wide: boolean }) => {
    const { top, me } = response
    const meAlreadyInTop = me !== null && top.some((entry) => entry.userId === me.userId)

    return (
        <UiEntity uiTransform={{ flexDirection: 'column', width: '100%' }}>
            {top.length === 0 ? (
                <Label value="No players ranked yet." fontSize={16} color={MUTED} />
            ) : (
                top.map((entry) => (
                    <UiEntity key={entry.userId} uiTransform={{ width: '100%' }}>
                        <LeaderboardRow entry={entry} highlighted={me !== null && entry.userId === me.userId} wide={wide} />
                    </UiEntity>
                ))
            )}

            {me === null ? (
                <UiEntity uiTransform={{ margin: { top: 14 } }}>
                    <Label value="You haven't made progress yet." fontSize={16} color={MUTED} />
                </UiEntity>
            ) : !meAlreadyInTop ? (
                <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', margin: { top: 14 } }}>
                    <Label value="YOUR RANK" fontSize={14} color={MUTED} uiTransform={{ margin: { bottom: 6 } }} />
                    <LeaderboardRow entry={me} highlighted={true} wide={wide} />
                </UiEntity>
            ) : null}
        </UiEntity>
    )
}

/**
 * One ranked row: rank (teal, secondary) + name (cream, primary) on the
 * left; Social Points (pink, primary) on the right. `highlighted` marks the
 * local player's own row (by userId match only - see LeaderboardReadyContent)
 * with a subtle pink tint (ROW_HIGHLIGHT), replacing the old strong purple
 * background. `entry.socialPoints` is now the Social Points v2 total
 * (validRounds + friendshipBonusPoints, getTotalSocialPoints) - the old
 * tier-based formula and its `questProgress` companion ("progress to next
 * tier") no longer exist on LeaderboardRankedEntry at all, migrated out in
 * leaderboardRanking.ts since that metric never meant anything under v2.
 */
const LeaderboardRow = ({ entry, highlighted, wide }: { entry: LeaderboardRankedEntry; highlighted: boolean; wide: boolean }) => {
    const rowHeight = wide ? LEADERBOARD_ROW_HEIGHT_WIDE : LEADERBOARD_ROW_HEIGHT_COMPACT

    return (
        <UiEntity
            uiTransform={{
                width: '100%',
                height: rowHeight,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: { left: 10, right: 10 },
                margin: { bottom: LEADERBOARD_ROW_GAP },
                borderRadius: highlighted ? ROW_HIGHLIGHT_BORDER_RADIUS : undefined
            }}
            uiBackground={highlighted ? { color: ROW_HIGHLIGHT } : undefined}
        >
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                <Label value={`#${entry.rank}`} fontSize={wide ? 16 : 14} color={TEAL_ACCENT} />
                <UiEntity uiTransform={{ width: wide ? 10 : 8 }} />
                <Label value={entry.displayName} fontSize={wide ? 20 : 16} color={CREAM} />
            </UiEntity>
            <Label value={`${entry.socialPoints} SP`} fontSize={wide ? 18 : 15} color={SOCIAL_PINK} />
        </UiEntity>
    )
}
