import ReactEcs, { Label, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { roundManager } from './roundManager'
import { requestLeaderboard, getLatestLeaderboardResponse, LeaderboardResponse } from './leaderboardNetwork'
import { LeaderboardRankedEntry } from './leaderboardRanking'

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

/** Same value as ui.tsx's own AGENDA_BUTTON_SIZE_WIDE/COMPACT, intentionally: the Leaderboard button is sized to match the Social Agenda button next to it in the HUD. Duplicated rather than imported - see this file's own top comment. Deliberately NOT restyled in this pass - it's a paired HUD icon with the (still-unstyled) Agenda button, and restyling only one half of that pair would read as an inconsistency rather than an improvement; it's a natural candidate for its own follow-up. */
const LEADERBOARD_BUTTON_SIZE_WIDE = 44
const LEADERBOARD_BUTTON_SIZE_COMPACT = 38

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

/** Whether the Leaderboard overlay is open - same role/lifecycle as ui.tsx's own socialAgendaOpen (presentation-only, local, never synced), mutually exclusive with it since both are centered overlays occupying the same screen region. Default: closed. Deliberately not exported directly - see isLeaderboardOpen/openLeaderboard/closeLeaderboard below. */
let leaderboardOpen = false

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
 * Opens the Leaderboard overlay (Phase 2B-3) - same fixed-position role in
 * the HUD group as SocialAgendaButton next to it, same ANSWERING/ANSWER
 * LOCKED tap-disable rule, same "✦" glyph already validated in production
 * (see celebration toasts) rather than an unverified new icon (see
 * AGENDA_BUTTON_* doc comment for why glyphs are chosen this carefully
 * here). A tap requests fresh data every time - no cached-is-good-enough
 * skip - but never clears whatever response is already showing, so a
 * previous result stays visible while the new one is in flight.
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
 */
export const LeaderboardButton = ({ wide, onOpen }: { wide: boolean; onOpen: () => void }) => {
    const size = wide ? LEADERBOARD_BUTTON_SIZE_WIDE : LEADERBOARD_BUTTON_SIZE_COMPACT

    return (
        <UiEntity
            uiTransform={{
                width: size,
                height: size,
                justifyContent: 'center',
                alignItems: 'center',
                borderColor: Color4.create(0.6, 0.45, 0.85, 1),
                borderWidth: 1,
                borderRadius: 8
            }}
            uiBackground={{ color: PANEL_BACKGROUND }}
            onMouseDown={() => {
                // Covers ANSWER LOCKED and the pre-round COUNTDOWN too - same reasoning as SocialAgendaButton above.
                const phase = roundManager.getSnapshot().phase
                if (phase === 'answering' || phase === 'countdown') return
                leaderboardOpen = true
                onOpen() // mutually exclusive centered overlays - see this component's own doc comment
                requestLeaderboard(LEADERBOARD_TOP_N) // exactly once per open, never on a tick/timer
            }}
        >
            <Label value="✦" fontSize={wide ? 22 : 18} color={Color4.create(1, 0.85, 0.2, 1)} />
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

            <UiEntity
                uiTransform={{
                    flexDirection: 'column',
                    width: '100%',
                    minHeight: wide ? LEADERBOARD_CONTENT_MIN_HEIGHT_WIDE : LEADERBOARD_CONTENT_MIN_HEIGHT_COMPACT,
                    padding: { top: 16, bottom: 20, left: 20, right: 20 }
                }}
            >
                {response === null ? (
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
                )}
            </UiEntity>
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
