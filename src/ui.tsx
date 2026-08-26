import ReactEcs, { Button, Label, ReactEcsRenderer, ScreenInsetArea, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { roundManager, RevealData, RevealEntry } from './roundManager'
import { playerSessionManager } from './playerSessionManager'
import { MIN_PLAYERS_REQUIRED } from './playerManager'
import { getTotalConnections, getDisplayNameFor, getAllConnections } from './connectionsManager'
import { getFriendshipLevel } from './friendshipManager'
import {
    getPresentedCelebration,
    PresentedNewConnectionCelebration,
    PresentedFriendshipCelebration
} from './socialCelebrationQueue'

/** Virtual design resolution this scene's UI is authored against - kept in sync with the setUiRenderer call below. */
const VIRTUAL_WIDTH = 1920
const VIRTUAL_HEIGHT = 1080

export function setupUi() {
    roundManager.start()
    playerSessionManager.start()
    ReactEcsRenderer.setUiRenderer(uiMenu, { virtualWidth: VIRTUAL_WIDTH, virtualHeight: VIRTUAL_HEIGHT })
}

const COLUMN_CENTERED = {
    width: '100%' as const,
    flexDirection: 'column' as const,
    alignItems: 'center' as const
}

const MUTED = Color4.create(0.7, 0.7, 0.75, 1)
const PANEL_BACKGROUND = Color4.create(0.05, 0.05, 0.1, 0.85)
/** Never used as an identity - purely a friendly presentation fallback when a name can't be resolved. */
const QUESTMATE_FALLBACK = 'Questmate'

/** Whether the Social Agenda ("VIEW ALL CONNECTIONS") overlay is open - presentation-only, local, never synced. Default: closed. */
let socialAgendaOpen = false
/** Current 0-based Agenda page - reset to 0 every time the Agenda is opened, so a re-open never resumes on a stale page. */
let socialAgendaPage = 0

/**
 * Below this render scale, panels declared at their normal size (the 280-wide HUD
 * panel) stop being comfortably legible/tappable, so the expanded HUD switches to
 * its narrower COMPACT width. Celebrations always use the compact toast now,
 * regardless of this breakpoint. 0.65 comes from wanting a 280-declared-unit
 * panel to still render at roughly >=180 real canvas px wide
 * (180/280 ~= 0.65) - derived from our own panel sizes, not a guessed window width.
 */
const WIDE_MIN_SCALE = 0.65

/**
 * How far the upper-center social row (Social HUD + celebration toast) sits
 * below the very top edge of the safe area - ScreenInsetArea already keeps
 * this clear of the device notch/status bar/rounded corners, so this is only
 * a small additional nudge, same on every platform. Kept deliberately close
 * to the top edge so the pill reads as clearly separate from the gameplay
 * panel below it.
 */
const HUD_TOP_MARGIN = 10

/** Extra vertical separation nudge between the CONNECTIONS pill above and the JOIN panel below it - JOIN only, per real-device feedback that they sat too close together. Every other phase's panel position is untouched. */
const JOIN_EXTRA_TOP_MARGIN = 16

/** Horizontal gap between the HUD and the celebration toast when shown side by side in WIDE. */
const WIDE_ROW_GAP = 24

/** Horizontal gap between the collapsed HUD pill and a compact celebration toast when shown side by side in normal COMPACT. Smaller than WIDE_ROW_GAP since compact horizontal room is tighter. */
const COMPACT_ROW_GAP = 16

/** Names shown before collapsing the rest into "+N" - shared by both compact toasts. */
const MAX_CELEBRATION_NAMES = 3

/**
 * Social Agenda ("VIEW ALL CONNECTIONS") panel width - it's a user-requested,
 * temporary central overlay (not the persistent HUD), so it's allowed to be
 * noticeably larger than the HUD panel while still leaving scene visible
 * around it. WIDE/COMPACT only, no separate very-small tier: pagination (see
 * AGENDA_ROWS_PER_PAGE) already keeps the panel's height bounded regardless of
 * canvas size, so a third width tier isn't needed to stay safe.
 */
const AGENDA_WIDTH_WIDE = 640
const AGENDA_WIDTH_COMPACT = 460

/**
 * Mobile-only Social Agenda sizing (compactUi = isMobile() || !wide - see its
 * doc comment). Percentage strings, not a fixed virtual-unit width like
 * AGENDA_WIDTH_*: a fixed unit can't reliably express "60-70% of the real
 * device viewport" across the very different aspect ratios mobile landscape
 * devices can have, whereas a percentage resolves against the actual
 * full-screen wrapper this modal already centers in, regardless of device.
 * Narrow-but-non-mobile desktop windows are unaffected - they still use the
 * fixed AGENDA_WIDTH_COMPACT exactly as before, since compactUi (not bare
 * `!wide`) gates this.
 */
const MOBILE_AGENDA_WIDTH = '65%'
const MOBILE_AGENDA_MAX_HEIGHT = '70%'

/**
 * Entries shown per Agenda page. Chosen instead of a scrolling container: the
 * installed SDK (@dcl/react-ecs 7.26.0) only exposes a raw Yoga `overflow:
 * 'scroll'` style flag with no programmatic scroll-position/scrollbar API, and
 * this project already hit one real Explorer-runtime regression from a
 * typings-only-verified component (InteractableArea). Prev/Next pagination
 * built from the same plain UiEntity/Button primitives already proven
 * throughout this file is the reliable choice here, per the explicit
 * "reliability over sophistication" guidance for this feature.
 */
const AGENDA_ROWS_PER_PAGE = 6

/**
 * Maximum names shown per RESULT option column before collapsing the rest into
 * "+N MORE" - keeps the timed, non-scrolling RESULT screen bounded regardless of
 * group size. Same WIDE_MIN_SCALE canvas-scale signal as everywhere else decides
 * which cap applies; no separate very-small tier for the columns themselves (see
 * report - the existing proportional virtual-canvas scaling already degrades
 * gracefully there, same as the rest of the gameplay panel's content).
 */
const REVEAL_MAX_NAMES_WIDE = 5
const REVEAL_MAX_NAMES_COMPACT = 3

/**
 * Per-row height of the RESULT name list, shared by real name rows and the
 * "+N MORE" row alike (unified to the same height so a row count converts to a
 * height with one exact formula). Used to give both A/B ResultColumns an
 * IDENTICAL reserved name-list height regardless of how many names either side
 * actually has - see RevealResults' requiredRows calculation - so the two cards
 * never end up visually unbalanced.
 */
const REVEAL_NAME_ROW_HEIGHT_WIDE = 26
const REVEAL_NAME_ROW_HEIGHT_COMPACT = 20
/** Vertical gap between consecutive name-list rows (both real names and the overflow row). */
const REVEAL_NAME_ROW_GAP = 4

/**
 * Option-title font sizes and reserved title-area height, ResultColumn's option
 * title (e.g. "B — An Exciting Possibility") can wrap to 2 lines for longer
 * question-bank options. Same root cause as the earlier name-overlap bug: a
 * bare wrap-enabled Label's rendered height isn't reliably fed back into this
 * SDK's flex layout, so an unsized wrapper let a 2-line title collide with the
 * stats line below it. Fixed the same proven way - an explicit, fixed-height
 * wrapper around the Label, sized generously enough (checked against the
 * longest known question-bank option strings, ~43 characters) to hold 2 lines
 * regardless of what the Label itself measures to. COMPACT's font is nudged
 * down slightly (16 -> 15) for a bit more breathing room in the narrower card.
 */
const REVEAL_TITLE_FONT_SIZE_WIDE = 20
const REVEAL_TITLE_FONT_SIZE_COMPACT = 15
const REVEAL_TITLE_AREA_HEIGHT_WIDE = 52
const REVEAL_TITLE_AREA_HEIGHT_COMPACT = 38

/** Reserved height for the "N PLAYERS · XX%" stats row - its own fixed-height row below the title area, so the title can never overlap it regardless of how many lines the title wraps to. */
const REVEAL_STATS_ROW_HEIGHT_WIDE = 22
const REVEAL_STATS_ROW_HEIGHT_COMPACT = 18

/**
 * WAITING always uses this compact fixed-size outer panel, on every platform
 * (see uiMenu's isWaitingPhase gate) - WAITING's content is minimal (a short
 * message + a count) on any screen size, so there's no reason to reserve the
 * bigger GAMEPLAY_PANEL_* size ANSWERING/ANSWER LOCKED/RESULT share for it.
 * JOIN keeps its own separate, unrelated sizing (see uiMenu) - untouched here.
 */
const WAITING_PANEL_WIDTH = 480
const WAITING_PANEL_PADDING = 20
const WAITING_TITLE_FONT_SIZE = 24
const WAITING_TITLE_MARGIN_BOTTOM = 6

/** WAITING's own text - fixed, unconditional values now (no wide/compact tiering): the same compact sizing applies on every platform. */
const WAITING_TEXT_FONT_SIZE = 22
const WAITING_TEXT_MARGIN_BOTTOM = 10
const WAITING_COUNT_FONT_SIZE = 17

/**
 * The one shared outer panel for ANSWERING, ANSWER LOCKED, and RESULT (see
 * uiMenu's isGameplayPanelPhase gate) - same width/padding/position/title on
 * every platform and across all three phases, with a FIXED height (not
 * auto) so the panel never resizes across that phase transition: ANSWER
 * LOCKED's shorter content just leaves blank space at the bottom instead of
 * shrinking the panel, and RESULT's cards have guaranteed room without ever
 * having driven the panel's size themselves. The height only tiers by
 * `compact` (isMobile() || !wide), same signal as everywhere else in this
 * file - GAMEPLAY_PANEL_HEIGHT_WIDE is sized to comfortably fit RESULT's own
 * worst case (REVEAL_MAX_NAMES_WIDE names + the "+N MORE" overflow row),
 * since RESULT's card content itself is unchanged and must always fit.
 */
const GAMEPLAY_PANEL_WIDTH = 760
const GAMEPLAY_PANEL_PADDING = 36
const GAMEPLAY_PANEL_HEIGHT_WIDE = 540
const GAMEPLAY_PANEL_HEIGHT_COMPACT = 430

/**
 * ANSWERING's own content sizing tiers by `compact` (isMobile() || !wide),
 * the same wide/compact-tier pattern RevealResults already uses for RESULT,
 * its already-proven-on-real-mobile reference. The outer panel itself is the
 * shared GAMEPLAY_PANEL_* shell above, not sized here.
 */
const ANSWERING_QUESTION_FONT_SIZE_WIDE = 32
const ANSWERING_QUESTION_FONT_SIZE_COMPACT = 24
const ANSWERING_QUESTION_MARGIN_BOTTOM_WIDE = 28
const ANSWERING_QUESTION_MARGIN_BOTTOM_COMPACT = 14
const ANSWERING_TIMER_FONT_SIZE_WIDE = 24
const ANSWERING_TIMER_FONT_SIZE_COMPACT = 16
const ANSWERING_TIMER_MARGIN_BOTTOM_WIDE = 28
const ANSWERING_TIMER_MARGIN_BOTTOM_COMPACT = 12
const ANSWERING_LOCKED_LABEL_FONT_SIZE_WIDE = 32
const ANSWERING_LOCKED_LABEL_FONT_SIZE_COMPACT = 18
const ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_WIDE = 12
const ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_COMPACT = 8

/**
 * Answer buttons side by side on every platform. Sized generously up front
 * (not left to auto-measure) for the same reason documented on the reveal
 * name-list fix: a wrapped Label's measured height isn't reliably fed back
 * into this SDK's flex layout. COMPACT keeps the exact values already
 * validated against a real mobile device in production; WIDE keeps its
 * original desktop size.
 */
const ANSWER_BUTTON_WIDTH_WIDE = 260
const ANSWER_BUTTON_HEIGHT_WIDE = 100
const ANSWER_BUTTON_GAP_WIDE = 16
const ANSWER_BUTTON_WIDTH_COMPACT = 200
const ANSWER_BUTTON_HEIGHT_COMPACT = 120
const ANSWER_BUTTON_GAP_COMPACT = 10

/** Dynamic font-size steps by option text length, now applied on BOTH tiers (previously compact-only) - a long option can't overflow its button on desktop either. */
const ANSWER_FONT_SIZE_SHORT_WIDE = 30
const ANSWER_FONT_SIZE_MEDIUM_WIDE = 24
const ANSWER_FONT_SIZE_LONG_WIDE = 18
const ANSWER_FONT_SIZE_SHORT_COMPACT = 20
const ANSWER_FONT_SIZE_MEDIUM_COMPACT = 17
const ANSWER_FONT_SIZE_LONG_COMPACT = 14
const ANSWER_SHORT_MAX_CHARS = 16
const ANSWER_MEDIUM_MAX_CHARS = 28

function answerFontSize(text: string, compact: boolean): number {
    if (text.length <= ANSWER_SHORT_MAX_CHARS) return compact ? ANSWER_FONT_SIZE_SHORT_COMPACT : ANSWER_FONT_SIZE_SHORT_WIDE
    if (text.length <= ANSWER_MEDIUM_MAX_CHARS) return compact ? ANSWER_FONT_SIZE_MEDIUM_COMPACT : ANSWER_FONT_SIZE_MEDIUM_WIDE
    return compact ? ANSWER_FONT_SIZE_LONG_COMPACT : ANSWER_FONT_SIZE_LONG_WIDE
}

/**
 * Reads the SDK-reported live UI canvas size (UiCanvasInformation on engine.RootEntity)
 * and derives the same contain-fit scale factor the renderer itself applies to this
 * scene's declared virtualWidth/virtualHeight (see setupUi above). This is real,
 * per-frame canvas/device data - not a guess based on typical browser window sizes -
 * so it shrinks exactly when the actual rendered UI shrinks, on any platform.
 */
function getUiScale(): number {
    const canvasInfo = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (!canvasInfo) return 1 // no canvas data yet - default to the normal full-size composition
    return Math.min(canvasInfo.width / VIRTUAL_WIDTH, canvasInfo.height / VIRTUAL_HEIGHT)
}

// draw your UI here
export const uiMenu = () => {
    const session = playerSessionManager.getSnapshot()
    const round = roundManager.getSnapshot()
    const scale = getUiScale()
    const wide = scale >= WIDE_MIN_SCALE
    /**
     * The one responsive signal reused everywhere in this file that needs a
     * compact/full-size tier decision. isMobile() (the Explorer's own reported
     * platform, from @dcl/sdk/platform) is OR'd in alongside the scale check
     * rather than replacing it: a real device's canvas-scale math depends on
     * devicePixelRatio in a way that isn't reliably knowable from scene code
     * alone, so a phone could in principle compute `wide === true` and miss
     * compact treatment if scale were the only signal. OR-ing can only WIDEN
     * which cases get the compact tier, never narrow it - desktop (isMobile()
     * always false there) still reduces to exactly `!wide`.
     */
    const compact = isMobile() || !wide
    /** WAITING is the one phase whose outer panel is always the small/compact size, on every platform - see WAITING_PANEL_* constants' doc comment. */
    const isWaitingPhase = round.phase === 'waiting'
    /**
     * ANSWERING/ANSWER LOCKED/RESULT - the three phases that share the fixed
     * GAMEPLAY_PANEL_HEIGHT_* shell (see its doc comment). Requires
     * session.joined: a round already in progress while this player hasn't
     * joined yet renders JoinScreen (via `round.phase !== 'waiting'`, its own
     * "JOIN NEXT ROUND" case), not JoinedGameplay - that JOIN screen keeps its
     * own separate, untouched sizing regardless of round.phase.
     */
    const isGameplayPanelPhase = session.joined && (round.phase === 'answering' || round.phase === 'result')
    /** Mirrors the exact condition JoinScreen renders under, below - used only to add JOIN_EXTRA_TOP_MARGIN to the panel for that one screen. */
    const showingJoinScreen =
        session.inZone && !session.joined && session.isSafeToJoin && round.afkMessage !== 'removed' && round.afkMessage !== 'warning'

    // At most one celebration occupies the notification slot at a time - guaranteed by
    // socialCelebrationQueue.ts itself (a local FIFO presentation queue), not by any
    // priority logic here. The UI is a pure consumer: it renders whichever single
    // celebration (if any) the queue says is currently presented, full stop.
    const presented = getPresentedCelebration()
    const presentedNewConnection = presented?.type === 'NEW_CONNECTION' ? presented : null
    const presentedFriendship = presented?.type === 'FRIENDSHIP' ? presented : null

    // Gameplay always wins: if the Social Agenda is open and the player's own question
    // now needs attention, close it automatically rather than let it compete for the
    // screen. Opening it in the first place is separately guarded the same way (see
    // SocialHud's VIEW ALL CONNECTIONS handler). Two triggers: ANSWERING begins WHILE
    // it's already open (the original rule), and - since the gameplay panel at
    // `session.inZone && !socialAgendaOpen` below is otherwise fully hidden behind an
    // open Agenda - walking into the Quest Zone *before joining* with the Agenda left
    // open from outside, which used to leave JOIN permanently hidden until the player
    // closed it manually. Deliberately NOT triggered by session.inZone alone once
    // joined: the Agenda must stay openable during WAITING/RESULT for an already-joined
    // player, same as before this fix. Local UI state only; never touches joined status
    // or round lifecycle.
    if (socialAgendaOpen && (round.phase === 'answering' || (session.inZone && !session.joined))) {
        socialAgendaOpen = false
    }

    return (
        // Keeps the panel clear of the device notch, status bar and rounded corners on mobile
        <ScreenInsetArea>
            {/* Persistent Social HUD + temporary celebrations, upper-center: real Explorer
                testing showed all four corners are native-UI territory (Explorer controls
                top-left/top-right, chat bottom-left, other controls bottom-right), so this is
                the one region confirmed visually clear. Sits HUD_TOP_MARGIN below the safe-area
                edge (ScreenInsetArea already handles the real device safe area) - same small
                offset on every platform, deliberately close to the top edge so the pill reads
                as clearly separate from the gameplay panel below it.

                Same fixed two-slot layout on every platform (not "center the group"): a
                LEFT/ANCHOR slot exactly 50% wide with Connections right-aligned inside it, so
                Connections' right edge always sits exactly on the horizontal center line - and
                a RIGHT slot, also always 50% wide whether or not it has content, holding the
                current celebration left-aligned just past that same line. Because both slot
                widths are fixed regardless of content, Connections' anchor can never shift when
                a celebration appears or disappears - unlike centering the pair as a single
                group, which moved Connections depending on the celebration's width. */}
            <UiEntity
                uiTransform={{
                    positionType: 'absolute',
                    position: { top: HUD_TOP_MARGIN },
                    width: '100%',
                    flexDirection: 'row',
                    alignItems: 'flex-start'
                }}
            >
                <UiEntity uiTransform={{ width: '50%', flexDirection: 'row', justifyContent: 'flex-end' }}>
                    {/* Single unconditional compact pill on every platform - hidden only during
                        ANSWERING, same rule everywhere, no separate mobile/desktop treatment. */}
                    {round.phase !== 'answering' && <SocialHud wide={wide} />}
                </UiEntity>
                {/* Compact toast presentation for the right slot on every platform - the large
                    cards felt unnecessarily obtrusive and were retired (see ui.tsx history).
                    `wide` still only affects the gap width here, never which presentation is
                    chosen. */}
                <UiEntity uiTransform={{ width: '50%', flexDirection: 'row', justifyContent: 'flex-start' }}>
                    {presentedNewConnection && (
                        <UiEntity uiTransform={{ margin: { left: wide ? WIDE_ROW_GAP : COMPACT_ROW_GAP } }}>
                            <NewConnectionToast data={presentedNewConnection} />
                        </UiEntity>
                    )}
                    {presentedFriendship && (
                        <UiEntity uiTransform={{ margin: { left: wide ? WIDE_ROW_GAP : COMPACT_ROW_GAP } }}>
                            <FriendshipToast data={presentedFriendship} />
                        </UiEntity>
                    )}
                </UiEntity>
            </UiEntity>

            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: '100%',
                    justifyContent: 'center',
                    alignItems: 'center'
                }}
            >
                {/* Presence in the scene is not participation: outside the Quest Zone, show nothing at all.
                    Also suppressed while the Social Agenda is open - both panels are translucent, so
                    rendering them together let the gameplay panel show through underneath the Agenda.
                    The Agenda temporarily owns this central area instead; gameplay reappears the instant
                    socialAgendaOpen goes false (including via the existing ANSWERING auto-close rule). */}
                {session.inZone && !socialAgendaOpen && (
                    <UiEntity
                        uiTransform={{
                            width: isWaitingPhase ? WAITING_PANEL_WIDTH : GAMEPLAY_PANEL_WIDTH,
                            height: isGameplayPanelPhase ? (compact ? GAMEPLAY_PANEL_HEIGHT_COMPACT : GAMEPLAY_PANEL_HEIGHT_WIDE) : undefined,
                            padding: isWaitingPhase ? WAITING_PANEL_PADDING : GAMEPLAY_PANEL_PADDING,
                            margin: { top: showingJoinScreen ? JOIN_EXTRA_TOP_MARGIN : 0 },
                            flexDirection: 'column',
                            alignItems: 'center'
                        }}
                        uiBackground={{ color: Color4.create(0.05, 0.05, 0.1, 0.85) }}
                    >
                        <Label
                            value="SOCIAL QUEST"
                            fontSize={isWaitingPhase ? WAITING_TITLE_FONT_SIZE : 56}
                            color={Color4.create(1, 0.85, 0.2, 1)}
                            uiTransform={{ margin: { bottom: isWaitingPhase ? WAITING_TITLE_MARGIN_BOTTOM : 18 } }}
                        />

                        {round.afkMessage === 'removed' ? (
                            <UiEntity uiTransform={COLUMN_CENTERED}>
                                <Label
                                    value="REMOVED FOR INACTIVITY"
                                    fontSize={30}
                                    color={Color4.create(1, 0.5, 0.4, 1)}
                                    uiTransform={{ margin: { bottom: 12 } }}
                                />
                                <Label value="You missed 2 questions." fontSize={22} color={MUTED} />
                            </UiEntity>
                        ) : round.afkMessage === 'warning' ? (
                            <UiEntity uiTransform={COLUMN_CENTERED}>
                                <Label
                                    value="STILL THERE?"
                                    fontSize={30}
                                    color={Color4.create(1, 0.85, 0.2, 1)}
                                    uiTransform={{ margin: { bottom: 12 } }}
                                />
                                <Label
                                    value="Answer the next question to stay in Social Quest."
                                    fontSize={20}
                                    textAlign="middle-center"
                                    textWrap="wrap"
                                    color={MUTED}
                                />
                            </UiEntity>
                        ) : !session.isSafeToJoin ? (
                            <Label value="PREPARING SOCIAL QUEST..." fontSize={32} color={MUTED} />
                        ) : !session.joined ? (
                            <JoinScreen />
                        ) : (
                            <JoinedGameplay />
                        )}
                    </UiEntity>
                )}
            </UiEntity>

            {/* Social Agenda - a user-requested temporary overlay, rendered last so it sits on
                top of the gameplay panel when both happen to be visible. Centered the same way
                the gameplay panel itself is (full-screen wrapper, justifyContent/alignItems
                center) - a proven technique already used above, not a new positioning system.
                Deliberately does not coordinate with the celebration toast in the fixed upper
                row: that row is untouched and keeps rendering normally regardless of Agenda's
                open state (see report for why this is the chosen simplest-safe behavior). */}
            {socialAgendaOpen && (
                <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }}>
                    <SocialAgenda wide={wide} compactUi={compact} />
                </UiEntity>
            )}
        </ScreenInsetArea>
    )
}

/** Shown while standing in the Quest Zone, before pressing JOIN. */
const JoinScreen = () => {
    const round = roundManager.getSnapshot()
    const roundAlreadyActive = !round.isSyncing && round.phase !== 'waiting'

    return (
        <UiEntity uiTransform={COLUMN_CENTERED}>
            {roundAlreadyActive && (
                <Label
                    value={`${round.activeParticipantCount} PLAYERS ACTIVE`}
                    fontSize={24}
                    color={MUTED}
                    uiTransform={{ margin: { bottom: 16 } }}
                />
            )}
            <Button
                value={roundAlreadyActive ? 'JOIN NEXT ROUND' : 'JOIN SOCIAL QUEST'}
                variant="primary"
                fontSize={28}
                uiTransform={{ width: 320, height: 90 }}
                onMouseDown={() => playerSessionManager.joinSocialQuest()}
            />
        </UiEntity>
    )
}

/** Shown once the local player has pressed JOIN - covers pending/waiting/answering/result. */
const JoinedGameplay = () => {
    const { phase, isPending, activeParticipantCount, question, selectedOption, secondsLeft, isRevealing, reveal } =
        roundManager.getSnapshot()
    const wide = getUiScale() >= WIDE_MIN_SCALE
    // Same isMobile()-OR'd signal as uiMenu's own `compact` - see its doc comment.
    const compact = isMobile() || !wide

    if (isPending) {
        return (
            <UiEntity uiTransform={COLUMN_CENTERED}>
                <Label
                    value="JOINING NEXT ROUND..."
                    fontSize={32}
                    textAlign="middle-center"
                    textWrap="wrap"
                    color={Color4.White()}
                />
            </UiEntity>
        )
    }

    if (phase === 'waiting') {
        return (
            <UiEntity uiTransform={COLUMN_CENTERED}>
                <Label
                    value="WAITING FOR ANOTHER PLAYER..."
                    fontSize={WAITING_TEXT_FONT_SIZE}
                    textAlign="middle-center"
                    textWrap="wrap"
                    color={Color4.White()}
                    uiTransform={{ width: '100%', margin: { bottom: WAITING_TEXT_MARGIN_BOTTOM } }}
                />
                <Label
                    value={`${activeParticipantCount} / ${MIN_PLAYERS_REQUIRED}`}
                    fontSize={WAITING_COUNT_FONT_SIZE}
                    color={MUTED}
                />
            </UiEntity>
        )
    }

    // Guaranteed non-null by RoundManager whenever phase is 'answering' or 'result'
    const activeQuestion = question as NonNullable<typeof question>
    const selectedLabel =
        selectedOption === 'A' ? activeQuestion.optionA : selectedOption === 'B' ? activeQuestion.optionB : null

    return (
        <UiEntity uiTransform={COLUMN_CENTERED}>
            <Label
                value={activeQuestion.question}
                fontSize={compact ? ANSWERING_QUESTION_FONT_SIZE_COMPACT : ANSWERING_QUESTION_FONT_SIZE_WIDE}
                textAlign="middle-center"
                textWrap="wrap"
                color={Color4.White()}
                uiTransform={{ width: '100%', margin: { bottom: compact ? ANSWERING_QUESTION_MARGIN_BOTTOM_COMPACT : ANSWERING_QUESTION_MARGIN_BOTTOM_WIDE } }}
            />

            {phase === 'answering' ? (
                <UiEntity uiTransform={COLUMN_CENTERED}>
                    {/* Countdown: visible but kept small so it stays secondary to the question/buttons */}
                    <Label
                        value={`${secondsLeft}s`}
                        fontSize={compact ? ANSWERING_TIMER_FONT_SIZE_COMPACT : ANSWERING_TIMER_FONT_SIZE_WIDE}
                        color={MUTED}
                        uiTransform={{ margin: { bottom: compact ? ANSWERING_TIMER_MARGIN_BOTTOM_COMPACT : ANSWERING_TIMER_MARGIN_BOTTOM_WIDE } }}
                    />

                    {selectedOption === null ? (
                        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                            <Button
                                value={activeQuestion.optionA}
                                variant="primary"
                                fontSize={answerFontSize(activeQuestion.optionA, compact)}
                                textWrap="wrap"
                                uiTransform={
                                    compact
                                        ? { width: ANSWER_BUTTON_WIDTH_COMPACT, height: ANSWER_BUTTON_HEIGHT_COMPACT, margin: { right: ANSWER_BUTTON_GAP_COMPACT } }
                                        : { width: ANSWER_BUTTON_WIDTH_WIDE, height: ANSWER_BUTTON_HEIGHT_WIDE, margin: { right: ANSWER_BUTTON_GAP_WIDE } }
                                }
                                onMouseDown={() => roundManager.selectOption('A')}
                            />
                            <Button
                                value={activeQuestion.optionB}
                                variant="primary"
                                fontSize={answerFontSize(activeQuestion.optionB, compact)}
                                textWrap="wrap"
                                uiTransform={
                                    compact
                                        ? { width: ANSWER_BUTTON_WIDTH_COMPACT, height: ANSWER_BUTTON_HEIGHT_COMPACT, margin: { left: ANSWER_BUTTON_GAP_COMPACT } }
                                        : { width: ANSWER_BUTTON_WIDTH_WIDE, height: ANSWER_BUTTON_HEIGHT_WIDE, margin: { left: ANSWER_BUTTON_GAP_WIDE } }
                                }
                                onMouseDown={() => roundManager.selectOption('B')}
                            />
                        </UiEntity>
                    ) : (
                        <UiEntity uiTransform={COLUMN_CENTERED}>
                            <Label
                                value="ANSWER LOCKED"
                                fontSize={compact ? ANSWERING_LOCKED_LABEL_FONT_SIZE_COMPACT : ANSWERING_LOCKED_LABEL_FONT_SIZE_WIDE}
                                color={Color4.create(0.6, 1, 0.6, 1)}
                                uiTransform={{ margin: { bottom: compact ? ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_COMPACT : ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_WIDE } }}
                            />
                            <Label
                                value={selectedLabel as string}
                                fontSize={answerFontSize(selectedLabel as string, compact)}
                                textAlign="middle-center"
                                textWrap="wrap"
                                color={Color4.White()}
                                uiTransform={{ width: '100%' }}
                            />
                        </UiEntity>
                    )}
                </UiEntity>
            ) : (
                <UiEntity uiTransform={COLUMN_CENTERED}>
                    {isRevealing || !reveal ? (
                        <Label value="REVEALING..." fontSize={32} color={MUTED} />
                    ) : (
                        <RevealResults optionAText={activeQuestion.optionA} optionBText={activeQuestion.optionB} reveal={reveal} />
                    )}
                </UiEntity>
            )}
        </UiEntity>
    )
}

/**
 * Two-column RESULT presentation: LEFT = Option A, RIGHT = Option B, equally
 * weighted (no winner/loser framing, no ranking). Purely a renderer of the
 * `reveal` snapshot it's given - reveal.entries/countA/countB are already
 * recomputed live every RoundManager.getSnapshot() call during RESULT (to
 * absorb late-arriving answers), and this component re-derives names/counts/
 * percentages/+N from that snapshot on every render, so a late answer updates
 * the columns automatically with no frozen state of its own. NO_ANSWER entries
 * (entry.option === null) are simply not included in either column, preserving
 * the existing reveal rule that they're excluded from the A/B comparison - no
 * third column was added.
 */
const RevealResults = ({ optionAText, optionBText, reveal }: { optionAText: string; optionBText: string; reveal: RevealData }) => {
    const wide = getUiScale() >= WIDE_MIN_SCALE
    const maxNames = wide ? REVEAL_MAX_NAMES_WIDE : REVEAL_MAX_NAMES_COMPACT

    const entriesA = reveal.entries.filter((entry) => entry.option === 'A')
    const entriesB = reveal.entries.filter((entry) => entry.option === 'B')

    // Both columns must render at the SAME height regardless of how many names either side
    // actually has (no winner/loser framing via card size) - so the "row budget" a column
    // reserves for its name list is the larger of what EITHER side needs, not its own count.
    // +1 accounts for the "+N MORE" overflow row when a side exceeds maxNames.
    const rowsNeededFor = (entries: RevealEntry[]) => Math.min(entries.length, maxNames) + (entries.length > maxNames ? 1 : 0)
    const requiredRows = Math.max(rowsNeededFor(entriesA), rowsNeededFor(entriesB))

    // Percentages are of VALID A/B answers only (never NO_ANSWER, never total participant
    // count) - matches the existing reveal rule that countA/countB already exclude NO_ANSWER.
    // percentB is derived as the complement of percentA (not independently rounded) so the
    // two displayed percentages always sum to exactly 100% - rounding both sides separately
    // can otherwise land on totals like 101% (e.g. 1/8 -> 13%, 7/8 -> 88%).
    const totalValid = reveal.countA + reveal.countB
    const percentA = totalValid > 0 ? Math.round((reveal.countA / totalValid) * 100) : 0
    const percentB = totalValid > 0 ? 100 - percentA : 0

    return (
        <UiEntity uiTransform={COLUMN_CENTERED}>
            <Label value="RESULTS" fontSize={32} color={Color4.create(0.85, 0.75, 1, 1)} uiTransform={{ margin: { bottom: 16 } }} />
            <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start' }}>
                <ResultColumn
                    label="A"
                    optionText={optionAText}
                    count={reveal.countA}
                    percent={percentA}
                    entries={entriesA}
                    maxNames={maxNames}
                    nameListRows={requiredRows}
                    wide={wide}
                />
                <UiEntity uiTransform={{ width: wide ? 24 : 14 }} />
                <ResultColumn
                    label="B"
                    optionText={optionBText}
                    count={reveal.countB}
                    percent={percentB}
                    entries={entriesB}
                    maxNames={maxNames}
                    nameListRows={requiredRows}
                    wide={wide}
                />
            </UiEntity>
        </UiEntity>
    )
}

/**
 * One RESULT option column. Both A and B use identical styling/weight - a shared
 * violet/lavender accent, no green/red, no "winner" treatment - per the "social
 * discovery, not competition" direction. Names are `entry.name`, resolved exactly
 * as before by roundManager's own buildRevealData() (unchanged) - not the
 * separate getDisplayNameFor/Questmate cache the HUD/Agenda/celebrations use,
 * since reveal names were already resolving correctly before this task and this
 * is presentation-only.
 */
const ResultColumn = ({
    label,
    optionText,
    count,
    percent,
    entries,
    maxNames,
    nameListRows,
    wide
}: {
    label: 'A' | 'B'
    optionText: string
    count: number
    percent: number
    entries: RevealEntry[]
    maxNames: number
    /** Shared row budget from RevealResults (the larger of what either A or B needs) - both columns reserve this same amount of name-list height, so neither card's size depends on its own content alone. */
    nameListRows: number
    wide: boolean
}) => {
    const shown = entries.slice(0, maxNames)
    const remaining = entries.length - shown.length
    const rowHeight = wide ? REVEAL_NAME_ROW_HEIGHT_WIDE : REVEAL_NAME_ROW_HEIGHT_COMPACT
    // Fixed height for nameListRows rows plus the gaps between them (none if there are no rows at all).
    const nameListHeight = nameListRows > 0 ? nameListRows * rowHeight + (nameListRows - 1) * REVEAL_NAME_ROW_GAP : 0

    return (
        <UiEntity
            uiTransform={{
                width: wide ? 320 : 220,
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: wide ? 18 : 12,
                borderColor: Color4.create(0.6, 0.45, 0.85, 1),
                borderWidth: 1,
                borderRadius: 10
            }}
            uiBackground={{ color: Color4.create(0.16, 0.09, 0.22, 0.85) }}
        >
            {/* Option title: its own explicit-height wrapper, same reliable technique as the
                name-list fix - the wrapped Label's own measured height isn't trusted, so the
                stats row below is positioned relative to this fixed box instead, regardless of
                whether the title actually renders as 1 or 2 lines. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: wide ? REVEAL_TITLE_AREA_HEIGHT_WIDE : REVEAL_TITLE_AREA_HEIGHT_COMPACT,
                    alignItems: 'flex-start',
                    margin: { bottom: 8 }
                }}
            >
                <Label
                    value={`${label} — ${optionText}`}
                    fontSize={wide ? REVEAL_TITLE_FONT_SIZE_WIDE : REVEAL_TITLE_FONT_SIZE_COMPACT}
                    color={Color4.create(0.85, 0.75, 1, 1)}
                    textWrap="wrap"
                    uiTransform={{ width: '100%' }}
                />
            </UiEntity>
            {/* Stats row: same fixed-height-wrapper treatment, so it can never overlap the
                names below it either. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: wide ? REVEAL_STATS_ROW_HEIGHT_WIDE : REVEAL_STATS_ROW_HEIGHT_COMPACT,
                    alignItems: 'flex-start',
                    margin: { bottom: 12 }
                }}
            >
                <Label value={`${count} PLAYER${count === 1 ? '' : 'S'} · ${percent}%`} fontSize={wide ? 16 : 13} color={MUTED} />
            </UiEntity>
            {/* Each name gets its own row container with an EXPLICIT height - the previous bare,
                wrap-enabled Labels stacked directly in this flex column didn't reliably report
                their wrapped-text height back into layout, so Yoga gave successive rows ~zero
                space and the names visually collapsed onto each other. A fixed row height sidesteps
                that text-measurement fragility entirely: it's correct regardless of what the text
                measures to, so rows can never overlap. Single-line (no textWrap) for the same
                reason - reliability over wrapping, per the SDK behavior actually observed here;
                an unusually long name may extend past the card rather than wrap, which is a lesser,
                pre-existing limitation (the original flat reveal list never truncated names either),
                not a regression from this fix. */}
            {/* Fixed-height list zone, sized from the SHARED nameListRows budget (not this
                column's own entry count) - this is what keeps the A and B cards the same
                total height even when one side has several names and the other has none.
                The emptier side just leaves clean blank space here; no fake placeholder
                names or "Nobody" text is ever rendered. */}
            <UiEntity uiTransform={{ width: '100%', height: nameListHeight, flexDirection: 'column' }}>
                {shown.map((entry, index) => {
                    const isLastRow = remaining === 0 && index === shown.length - 1
                    return (
                        <UiEntity
                            key={entry.userId}
                            uiTransform={{ width: '100%', height: rowHeight, alignItems: 'center', margin: { bottom: isLastRow ? 0 : REVEAL_NAME_ROW_GAP } }}
                        >
                            <Label value={entry.name} fontSize={wide ? 18 : 14} color={Color4.White()} />
                        </UiEntity>
                    )
                })}
                {remaining > 0 && (
                    <UiEntity uiTransform={{ width: '100%', height: rowHeight, alignItems: 'center' }}>
                        <Label value={`+${remaining} MORE`} fontSize={wide ? 15 : 12} color={MUTED} />
                    </UiEntity>
                )}
            </UiEntity>
        </UiEntity>
    )
}

/**
 * Persistent social status bar - visible anywhere in the scene, regardless of Quest
 * Zone/join/round state, except during ANSWERING (see uiMenu). Consumes
 * connectionsManager's read API only; no relationship logic is reconstructed here.
 * Single unconditional compact pill on every platform - same structure/text/
 * behavior everywhere, `wide` only nudges fontSize/padding. A tap always opens the
 * Social Agenda overlay directly; there is no expanded inline panel anymore. The
 * whole pill is the tap target (generous padding, not just the text), and the
 * ANSWERING guard below is defense in depth - in practice this pill isn't even
 * rendered during ANSWERING (see uiMenu's `round.phase !== 'answering'` gate).
 */
const SocialHud = ({ wide }: { wide: boolean }) => {
    const total = getTotalConnections()

    return (
        <UiEntity
            uiTransform={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: wide ? { top: 12, bottom: 12, left: 16, right: 16 } : { top: 10, bottom: 10, left: 14, right: 14 }
            }}
            uiBackground={{ color: PANEL_BACKGROUND }}
            onMouseDown={() => {
                if (roundManager.getSnapshot().phase === 'answering') return
                socialAgendaPage = 0
                socialAgendaOpen = true
            }}
        >
            <Label value={`CONNECTIONS · ${total}`} fontSize={wide ? 18 : 16} color={Color4.White()} />
        </UiEntity>
    )
}

/**
 * Full-list overlay - opened via SocialHud's VIEW ALL CONNECTIONS button on
 * desktop, or directly from a tap on the compact pill on mobile/compactUi
 * (see SocialHud). Reads connectionsManager's existing getAllConnections()
 * directly - no second list of
 * relationships, no new Connection state. Ordering is whatever getAllConnections()
 * already returns: Map insertion order, i.e. the order each partner was first met
 * in, oldest-first - a genuinely stable, deterministic order with no invented
 * recency/ranking system layered on top (see report). Friendship level is the same
 * pure getFriendshipLevel(roundsTogether) lookup used everywhere else - no
 * threshold logic duplicated here. Paginated rather than scrolled - see
 * AGENDA_ROWS_PER_PAGE's comment for why.
 */
const SocialAgenda = ({ wide, compactUi }: { wide: boolean; compactUi: boolean }) => {
    const allConnections = getAllConnections()
    const totalPages = Math.max(1, Math.ceil(allConnections.length / AGENDA_ROWS_PER_PAGE))
    const pageStart = socialAgendaPage * AGENDA_ROWS_PER_PAGE
    const pageEntries = allConnections.slice(pageStart, pageStart + AGENDA_ROWS_PER_PAGE)
    const canGoPrevious = socialAgendaPage > 0
    const canGoNext = socialAgendaPage < totalPages - 1

    const close = () => {
        socialAgendaOpen = false
    }

    return (
        <UiEntity
            uiTransform={
                compactUi
                    ? { flexDirection: 'column', width: MOBILE_AGENDA_WIDTH, maxHeight: MOBILE_AGENDA_MAX_HEIGHT }
                    : { flexDirection: 'column', width: wide ? AGENDA_WIDTH_WIDE : AGENDA_WIDTH_COMPACT }
            }
            uiBackground={{ color: PANEL_BACKGROUND }}
        >
            {/* Header is the whole-row tap target to close - generous padding (not just the "✕"
                glyph), same proven pattern as SocialHud's own header. This is the only close
                control now; no footer bar (see report). */}
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
                <Label value="MY SOCIAL QUEST" fontSize={22} color={Color4.create(1, 0.85, 0.2, 1)} />
                <Label value="✕" fontSize={22} color={Color4.White()} />
            </UiEntity>

            <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', padding: { top: 16, bottom: 20, left: 20, right: 20 } }}>
                {allConnections.length === 0 ? (
                    <UiEntity uiTransform={COLUMN_CENTERED}>
                        <Label value="No Connections yet." fontSize={20} color={Color4.White()} uiTransform={{ margin: { bottom: 8 } }} />
                        <Label
                            value="Play Social Quest with someone to make your first Connection."
                            fontSize={16}
                            color={MUTED}
                            textAlign="middle-center"
                            textWrap="wrap"
                        />
                    </UiEntity>
                ) : (
                    <UiEntity uiTransform={{ flexDirection: 'column', width: '100%' }}>
                        <Label
                            value={`${allConnections.length} CONNECTION${allConnections.length === 1 ? '' : 'S'}`}
                            fontSize={16}
                            color={MUTED}
                            uiTransform={{ margin: { bottom: 14 } }}
                        />
                        {pageEntries.map((connection) => {
                            const name = getDisplayNameFor(connection.otherUserId) ?? QUESTMATE_FALLBACK
                            const level = getFriendshipLevel(connection.roundsTogether)
                            return (
                                <UiEntity key={connection.otherUserId} uiTransform={{ width: '100%', flexDirection: 'column', margin: { bottom: 12 } }}>
                                    <Label value={name} fontSize={20} color={Color4.White()} />
                                    {level !== null && (
                                        <Label
                                            value={`✦ ${level} · ${connection.roundsTogether} ROUND${connection.roundsTogether === 1 ? '' : 'S'}`}
                                            fontSize={16}
                                            color={Color4.create(0.4, 0.75, 1, 1)}
                                            textWrap="wrap"
                                        />
                                    )}
                                </UiEntity>
                            )
                        })}

                        {totalPages > 1 && (
                            <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', margin: { top: 8 } }}>
                                <UiEntity
                                    uiTransform={{ padding: { top: 10, bottom: 10, left: 16, right: 16 } }}
                                    uiBackground={{ color: PANEL_BACKGROUND }}
                                    onMouseDown={() => {
                                        if (canGoPrevious) socialAgendaPage -= 1
                                    }}
                                >
                                    <Label value="PREVIOUS" fontSize={16} color={canGoPrevious ? Color4.White() : MUTED} />
                                </UiEntity>
                                <Label value={`${socialAgendaPage + 1} / ${totalPages}`} fontSize={16} color={MUTED} />
                                <UiEntity
                                    uiTransform={{ padding: { top: 10, bottom: 10, left: 16, right: 16 } }}
                                    uiBackground={{ color: PANEL_BACKGROUND }}
                                    onMouseDown={() => {
                                        if (canGoNext) socialAgendaPage += 1
                                    }}
                                >
                                    <Label value="NEXT" fontSize={16} color={canGoNext ? Color4.White() : MUTED} />
                                </UiEntity>
                            </UiEntity>
                        )}
                    </UiEntity>
                )}
            </UiEntity>
        </UiEntity>
    )
}

/** Joins up to MAX_CELEBRATION_NAMES names with " + ", collapsing the rest into "+N" - shared by both compact toasts. */
function joinNamesForToast(names: string[]): string {
    const shown = names.slice(0, MAX_CELEBRATION_NAMES)
    const remaining = names.length - shown.length
    const joined = shown.join(' + ')
    return remaining > 0 ? `${joined} +${remaining}` : joined
}

/**
 * Single-line toast for a NEW CONNECTION, shown in the right slot of the upper
 * social row (see uiMenu) - the sole NEW CONNECTION presentation now, in WIDE,
 * normal COMPACT, and (alone, replacing Connections) very-small. Never stacks a
 * tall card under or beside the HUD and can never grow the distance to the
 * gameplay panel below. Purely a renderer of the data it's given; builds no
 * relationship/queue logic of its own.
 */
const NewConnectionToast = ({ data }: { data: PresentedNewConnectionCelebration }) => {
    let unresolvedCount = 0
    const names = data.newUserIds.map((userId) => getDisplayNameFor(userId) ?? `${QUESTMATE_FALLBACK} ${++unresolvedCount}`)
    // Grouped-count meaning preserved from the retired large card: "NEW CONNECTION" for one
    // partner, "N NEW CONNECTIONS" when several are grouped into the same celebration.
    const headerText = names.length === 1 ? 'NEW CONNECTION' : `${names.length} NEW CONNECTIONS`
    const text = `✦ ${headerText} · ${joinNamesForToast(names)}`

    return (
        <UiEntity
            uiTransform={{ flexDirection: 'row', alignItems: 'center', padding: { top: 10, bottom: 10, left: 16, right: 16 } }}
            uiBackground={{ color: Color4.create(0.35, 0.08, 0.25, 0.92) }}
        >
            <Label value={text} fontSize={18} color={Color4.White()} textAlign="middle-center" textWrap="wrap" />
        </UiEntity>
    )
}

/** Single-line toast for a FRIENDSHIP LEVEL UP - the sole Friendship presentation now, same as NewConnectionToast (see its doc comment). */
const FriendshipToast = ({ data }: { data: PresentedFriendshipCelebration }) => {
    let unresolvedCount = 0
    const names = data.userIds.map((userId) => getDisplayNameFor(userId) ?? `${QUESTMATE_FALLBACK} ${++unresolvedCount}`)
    const levelText = data.level ?? 'LEVEL UP'
    const roundsText =
        data.level !== null && data.roundsTogether !== null ? ` · ${data.roundsTogether} ROUND${data.roundsTogether === 1 ? '' : 'S'}` : ''
    const text = `✦ ${levelText} · ${joinNamesForToast(names)}${roundsText}`

    return (
        <UiEntity
            uiTransform={{ flexDirection: 'row', alignItems: 'center', padding: { top: 10, bottom: 10, left: 16, right: 16 } }}
            uiBackground={{ color: Color4.create(0.08, 0.2, 0.35, 0.92) }}
        >
            <Label value={text} fontSize={18} color={Color4.White()} textAlign="middle-center" textWrap="wrap" />
        </UiEntity>
    )
}
