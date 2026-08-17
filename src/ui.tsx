import ReactEcs, { Button, Label, ReactEcsRenderer, ScreenInsetArea, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { roundManager } from './roundManager'
import { playerSessionManager } from './playerSessionManager'
import { MIN_PLAYERS_REQUIRED } from './playerManager'
import { getTotalConnections, getRecentConnections, getDisplayNameFor, getConnection } from './connectionsManager'
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

/** Collapse/expand is presentation-only and local to this client - never synced. Default: collapsed. */
let socialHudExpanded = false

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
 * Below this render scale, space is tight enough that gameplay must win outright:
 * the Social HUD is forced collapsed unconditionally (not just during ANSWERING as
 * in the normal COMPACT rule), on top of the COMPACT narrowing already in effect.
 * Chosen well below WIDE_MIN_SCALE so it only engages on genuinely small viewports.
 */
const VERY_SMALL_MAX_SCALE = 0.4

/**
 * How far the upper-center social row sits below the very top edge of the safe
 * area - deliberately more than a token amount so it visually reads as part of
 * Social Quest rather than Decentraland's own top bar, per real-Explorer feedback
 * that the top edge itself is native-UI territory.
 */
const HUD_TOP_MARGIN = 56

/** Horizontal gap between the HUD and the celebration toast when shown side by side in WIDE. */
const WIDE_ROW_GAP = 24

/** Horizontal gap between the collapsed HUD pill and a compact celebration toast when shown side by side in normal COMPACT. Smaller than WIDE_ROW_GAP since compact horizontal room is tighter. */
const COMPACT_ROW_GAP = 16

/** Expanded HUD panel width: WIDE uses the original size, COMPACT narrows it so it demands less of a small canvas's width. */
const HUD_EXPANDED_WIDTH_WIDE = 280
const HUD_EXPANDED_WIDTH_COMPACT = 230

/** Names shown before collapsing the rest into "+N" - shared by both compact toasts. */
const MAX_CELEBRATION_NAMES = 3

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
    const verySmall = scale < VERY_SMALL_MAX_SCALE

    // At most one celebration occupies the notification slot at a time - guaranteed by
    // socialCelebrationQueue.ts itself (a local FIFO presentation queue), not by any
    // priority logic here. The UI is a pure consumer: it renders whichever single
    // celebration (if any) the queue says is currently presented, full stop.
    const presented = getPresentedCelebration()
    const presentedNewConnection = presented?.type === 'NEW_CONNECTION' ? presented : null
    const presentedFriendship = presented?.type === 'FRIENDSHIP' ? presented : null
    const celebrating = presented !== null

    // Whether the Connections pill/panel is shown at all this render. WIDE always shows it.
    // Normal COMPACT (not wide, but not verySmall either) also keeps it visible side by side
    // with a celebration toast - there's genuinely enough horizontal room there. Only the
    // very-small fallback (scale < VERY_SMALL_MAX_SCALE, the same canvas-scale signal already
    // used to force-collapse elsewhere) hides it in favor of the toast alone, restoring it
    // automatically once the celebration's own snapshot goes null.
    const showHud = !(verySmall && celebrating)

    // Compact screens give gameplay priority: an expanded HUD auto-collapses to the pill the
    // moment a new ANSWERING phase begins, so it can never sit over the answer buttons. The
    // same applies the moment a celebration is active in COMPACT/very-small - the expanded
    // MY SOCIAL QUEST panel is never shown alongside or instead of a celebration, only the
    // collapsed pill (or nothing, in the very-small fallback) is, so it always comes back
    // collapsed once the celebration clears. Very small screens go further and force it
    // collapsed unconditionally, regardless of phase. Wide screens keep the HUD and a full
    // celebration card side by side and are left alone.
    if (socialHudExpanded && (verySmall || (!wide && (round.phase === 'answering' || celebrating)))) {
        socialHudExpanded = false
    }

    return (
        // Keeps the panel clear of the device notch, status bar and rounded corners on mobile
        <ScreenInsetArea>
            {/* Persistent Social HUD + temporary celebrations, upper-center: real Explorer
                testing showed all four corners are native-UI territory (Explorer controls
                top-left/top-right, chat bottom-left, other controls bottom-right), so this is
                the one region confirmed visually clear. Sits HUD_TOP_MARGIN below the safe-area
                edge rather than flush against it, so it reads as Social Quest UI, not part of
                Decentraland's own top bar.

                Fixed two-slot layout (not "center the group"): a LEFT/ANCHOR slot exactly 50%
                wide with Connections right-aligned inside it, so Connections' right edge always
                sits exactly on the horizontal center line - and a RIGHT slot, also always 50%
                wide whether or not it has content, holding the current celebration left-aligned
                just past that same line. Because both slot widths are fixed regardless of
                content, Connections' anchor can never shift when a celebration appears or
                disappears - unlike centering the pair as a single group, which moved Connections
                depending on the celebration's width. */}
            <UiEntity
                uiTransform={{
                    positionType: 'absolute',
                    position: { top: HUD_TOP_MARGIN },
                    width: '100%',
                    flexDirection: 'row',
                    alignItems: 'flex-start'
                }}
            >
                {verySmall && celebrating ? (
                    // Very-small fallback only: no anchor slot here at all - Connections is
                    // fully hidden (showHud false) and the toast takes the whole row, centered,
                    // per the manually-approved fallback. Connections resumes its normal
                    // left-of-center anchor automatically once celebrating goes false again.
                    <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                        {presentedNewConnection && <NewConnectionToast data={presentedNewConnection} />}
                        {presentedFriendship && <FriendshipToast data={presentedFriendship} />}
                    </UiEntity>
                ) : (
                    <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'flex-start' }}>
                        <UiEntity uiTransform={{ width: '50%', flexDirection: 'row', justifyContent: 'flex-end' }}>
                            <SocialHud wide={wide} />
                        </UiEntity>
                        {/* Compact toast presentation for the right slot in BOTH wide and normal
                            compact now - the large cards felt unnecessarily obtrusive and were
                            retired (see ui.tsx history). The breakpoint still only affects the
                            gap width here, never which presentation is chosen. */}
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
                )}
            </UiEntity>

            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: '100%',
                    justifyContent: 'center',
                    alignItems: 'center'
                }}
            >
                {/* Presence in the scene is not participation: outside the Quest Zone, show nothing at all */}
                {session.inZone && (
                    <UiEntity
                        uiTransform={{
                            width: 760,
                            padding: 36,
                            flexDirection: 'column',
                            alignItems: 'center'
                        }}
                        uiBackground={{ color: Color4.create(0.05, 0.05, 0.1, 0.85) }}
                    >
                        <Label
                            value="SOCIAL QUEST"
                            fontSize={56}
                            color={Color4.create(1, 0.85, 0.2, 1)}
                            uiTransform={{ margin: { bottom: 18 } }}
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
                    fontSize={32}
                    textAlign="middle-center"
                    textWrap="wrap"
                    color={Color4.White()}
                    uiTransform={{ width: '100%', margin: { bottom: 16 } }}
                />
                <Label value={`${activeParticipantCount} / ${MIN_PLAYERS_REQUIRED}`} fontSize={24} color={MUTED} />
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
                fontSize={32}
                textAlign="middle-center"
                textWrap="wrap"
                color={Color4.White()}
                uiTransform={{ width: '100%', margin: { bottom: 28 } }}
            />

            {phase === 'answering' ? (
                <UiEntity uiTransform={COLUMN_CENTERED}>
                    {/* Countdown: visible but kept small so it stays secondary to the question/buttons */}
                    <Label value={`${secondsLeft}s`} fontSize={24} color={MUTED} uiTransform={{ margin: { bottom: 28 } }} />

                    {selectedOption === null ? (
                        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                            <Button
                                value={activeQuestion.optionA}
                                variant="primary"
                                fontSize={30}
                                uiTransform={{ width: 260, height: 100, margin: { right: 16 } }}
                                onMouseDown={() => roundManager.selectOption('A')}
                            />
                            <Button
                                value={activeQuestion.optionB}
                                variant="primary"
                                fontSize={30}
                                uiTransform={{ width: 260, height: 100, margin: { left: 16 } }}
                                onMouseDown={() => roundManager.selectOption('B')}
                            />
                        </UiEntity>
                    ) : (
                        <UiEntity uiTransform={COLUMN_CENTERED}>
                            <Label
                                value="ANSWER LOCKED"
                                fontSize={32}
                                color={Color4.create(0.6, 1, 0.6, 1)}
                                uiTransform={{ margin: { bottom: 12 } }}
                            />
                            <Label value={selectedLabel as string} fontSize={48} color={Color4.White()} />
                        </UiEntity>
                    )}
                </UiEntity>
            ) : (
                <UiEntity uiTransform={COLUMN_CENTERED}>
                    {isRevealing || !reveal ? (
                        <Label value="REVEALING..." fontSize={32} color={MUTED} />
                    ) : (
                        <UiEntity uiTransform={COLUMN_CENTERED}>
                            <Label
                                value="RESULTS"
                                fontSize={32}
                                color={Color4.create(0.6, 1, 0.6, 1)}
                                uiTransform={{ margin: { bottom: 12 } }}
                            />
                            {reveal.entries.map((entry) => (
                                <Label
                                    key={entry.userId}
                                    value={`${entry.name} — ${
                                        entry.option === 'A'
                                            ? activeQuestion.optionA
                                            : entry.option === 'B'
                                              ? activeQuestion.optionB
                                              : 'NO ANSWER'
                                    }`}
                                    fontSize={22}
                                    color={Color4.White()}
                                    uiTransform={{ margin: { bottom: 4 } }}
                                />
                            ))}
                            <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 12 } }}>
                                <Label
                                    value={`${activeQuestion.optionA}: ${reveal.countA}`}
                                    fontSize={20}
                                    color={MUTED}
                                    uiTransform={{ margin: { right: 16 } }}
                                />
                                <Label value={`${activeQuestion.optionB}: ${reveal.countB}`} fontSize={20} color={MUTED} />
                            </UiEntity>
                        </UiEntity>
                    )}
                </UiEntity>
            )}
        </UiEntity>
    )
}

/**
 * Persistent social status bar - visible anywhere in the scene, regardless of Quest
 * Zone/join/round state. Consumes connectionsManager's read API only; no relationship
 * logic is reconstructed here. Collapsed by default; toggled via a normal click/touch
 * target (no hover dependence, per mobile requirements).
 */
const SocialHud = ({ wide }: { wide: boolean }) => {
    const total = getTotalConnections()

    if (!socialHudExpanded) {
        // The whole pill is the tap target (generous padding, not just the arrow glyph) -
        // onMouseDown lives on this same outer row that carries the background, so the
        // entire visible rectangle is one coherent button, not just the "▼" character.
        return (
            <UiEntity
                uiTransform={{ flexDirection: 'row', alignItems: 'center', padding: { top: 12, bottom: 12, left: 16, right: 16 } }}
                uiBackground={{ color: PANEL_BACKGROUND }}
                onMouseDown={() => {
                    socialHudExpanded = true
                }}
            >
                <Label value={`CONNECTIONS  ${total}`} fontSize={20} color={Color4.White()} uiTransform={{ margin: { right: 8 } }} />
                <Label value="▼" fontSize={18} color={Color4.White()} />
            </UiEntity>
        )
    }

    // Questmate numbering is presentation-only and scoped to this single render of the
    // recent list - it never substitutes for the real userId identity.
    const recentUserIds = getRecentConnections()
    let unresolvedCount = 0
    const recentLabels = recentUserIds.map((userId) => {
        const cachedName = getDisplayNameFor(userId)
        if (cachedName) return cachedName
        unresolvedCount += 1
        return `${QUESTMATE_FALLBACK} ${unresolvedCount}`
    })

    return (
        <UiEntity
            uiTransform={{ flexDirection: 'column', width: wide ? HUD_EXPANDED_WIDTH_WIDE : HUD_EXPANDED_WIDTH_COMPACT }}
            uiBackground={{ color: PANEL_BACKGROUND }}
        >
            {/* Header is its own full-width row with its own background and generous padding -
                the whole bar is the tap target to collapse, not just the "▲" glyph, and it's a
                sibling of (not a wrapper around) the body below, so a tap on Recent Connections
                content can never register as a header tap. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: { top: 12, bottom: 12, left: 16, right: 16 }
                }}
                uiBackground={{ color: PANEL_BACKGROUND }}
                onMouseDown={() => {
                    socialHudExpanded = false
                }}
            >
                <Label value="MY SOCIAL QUEST" fontSize={18} color={Color4.create(1, 0.85, 0.2, 1)} />
                <Label value="▲" fontSize={20} color={Color4.White()} />
            </UiEntity>

            <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', padding: { top: 16, bottom: 20, left: 20, right: 20 } }}>
                <Label value="CONNECTIONS" fontSize={14} color={MUTED} uiTransform={{ margin: { bottom: 4 } }} />
                <Label value={`${total}`} fontSize={28} color={Color4.White()} uiTransform={{ margin: { bottom: 16 } }} />

                {recentLabels.length > 0 && (
                    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
                        <Label value="RECENT CONNECTIONS" fontSize={14} color={MUTED} uiTransform={{ margin: { bottom: 6 } }} />
                        {recentUserIds.map((userId, index) => {
                            // Friendship level is derived here purely from the existing ConnectionRecord's
                            // roundsTogether via friendshipManager's own pure lookup - no new state, no
                            // threshold logic duplicated in the UI. roundsTogether defaults to 0 (level null,
                            // line omitted) only in the defensive case getConnection somehow returns null,
                            // which shouldn't happen for a userId that's already in the recent list.
                            const roundsTogether = getConnection(userId)?.roundsTogether ?? 0
                            const level = getFriendshipLevel(roundsTogether)
                            return (
                                <UiEntity key={userId} uiTransform={{ width: '100%', flexDirection: 'column', margin: { bottom: 8 } }}>
                                    <Label value={recentLabels[index]} fontSize={18} color={Color4.White()} />
                                    {level !== null && (
                                        <Label
                                            value={`✦ ${level} · ${roundsTogether} ROUND${roundsTogether === 1 ? '' : 'S'}`}
                                            fontSize={14}
                                            color={Color4.create(0.4, 0.75, 1, 1)}
                                            textWrap="wrap"
                                        />
                                    )}
                                </UiEntity>
                            )
                        })}
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
