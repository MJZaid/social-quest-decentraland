import ReactEcs, { Label, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { roundManager } from './roundManager'
import { requestLeaderboard, getLatestLeaderboardResponse, LeaderboardResponse } from './leaderboardNetwork'
import { LeaderboardRankedEntry } from './leaderboardRanking'

// -----------------------------------------------------------------------
// LEADERBOARD UI - extracted 1:1 from ui.tsx (structural-only move, no
// behavior or visual change). Own copies of the small shared constants
// (PANEL_BACKGROUND/MUTED/button size) it needs from ui.tsx below, rather
// than importing them back from there - ui.tsx already depends on this file
// (LeaderboardButton/LeaderboardPanel), so importing the reverse direction
// would make the two files circular. These duplicated values are also the
// first things Phase 2's visual redesign will replace, so keeping them
// duplicated for exactly one phase costs nothing.
// -----------------------------------------------------------------------

const MUTED = Color4.create(0.7, 0.7, 0.75, 1)
const PANEL_BACKGROUND = Color4.create(0.05, 0.05, 0.1, 0.85)

/** Same value as ui.tsx's own AGENDA_BUTTON_SIZE_WIDE/COMPACT, intentionally: the Leaderboard button is sized to match the Social Agenda button next to it in the HUD. Duplicated rather than imported - see this file's own top comment. */
const LEADERBOARD_BUTTON_SIZE_WIDE = 44
const LEADERBOARD_BUTTON_SIZE_COMPACT = 38

/**
 * How many ranked players the Leaderboard overlay requests/shows - fixed,
 * no scroll/pagination in this first version (Phase 2B-3). A deliberately
 * small, controllable number; a later phase can raise it once the panel
 * needs to show more.
 */
const LEADERBOARD_TOP_N = 5

/** Leaderboard overlay panel width, same wide/compact tiering signal as every other panel in this file. Deliberately smaller than the Social Agenda panel - its content is a short, fixed-length list (LEADERBOARD_TOP_N rows + at most one extra "Your Rank" row), never a paginated arbitrary-length one. */
const LEADERBOARD_WIDTH_WIDE = 480
const LEADERBOARD_WIDTH_COMPACT = 380

/** Fixed per-row height, same reliability reasoning as REVEAL_NAME_ROW_HEIGHT and the Agenda's name rows above - a row's height is never left to auto-measure from its Label. */
const LEADERBOARD_ROW_HEIGHT_WIDE = 32
const LEADERBOARD_ROW_HEIGHT_COMPACT = 26
const LEADERBOARD_ROW_GAP = 6

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
            uiTransform={{ flexDirection: 'column', width: wide ? LEADERBOARD_WIDTH_WIDE : LEADERBOARD_WIDTH_COMPACT }}
            uiBackground={{ color: PANEL_BACKGROUND }}
        >
            {/* Header is the whole-row tap target to close - same proven pattern as the Social Agenda's own header. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: { top: 18, bottom: 18, left: 20, right: 20 }
                }}
                uiBackground={{ color: PANEL_BACKGROUND }}
                onMouseDown={close}
            >
                <Label value="LEADERBOARD" fontSize={22} color={Color4.create(1, 0.85, 0.2, 1)} />
                <Label value="✕" fontSize={22} color={Color4.White()} />
            </UiEntity>

            <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', padding: { top: 16, bottom: 20, left: 20, right: 20 } }}>
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

/** One ranked row: rank/name on the left, Social Points/Quest Progress on the right. `highlighted` marks the local player's own row (by userId match only - see LeaderboardReadyContent) with a tinted background, same accent color already used for borders throughout this file. */
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
                padding: { left: 8, right: 8 },
                margin: { bottom: LEADERBOARD_ROW_GAP }
            }}
            uiBackground={highlighted ? { color: Color4.create(0.6, 0.45, 0.85, 0.35) } : undefined}
        >
            <Label value={`#${entry.rank}  ${entry.displayName}`} fontSize={wide ? 18 : 15} color={Color4.White()} />
            <Label value={`${entry.socialPoints} SP · ${entry.questProgress}/5`} fontSize={wide ? 14 : 12} color={MUTED} />
        </UiEntity>
    )
}
