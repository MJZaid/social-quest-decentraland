import ReactEcs, { Button, Label, ReactEcsRenderer, ScreenInsetArea, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { roundManager } from './roundManager'
import { playerSessionManager } from './playerSessionManager'
import { MIN_PLAYERS_REQUIRED } from './playerManager'
import { getTotalConnections, getRecentConnections, getDisplayNameFor } from './connectionsManager'

export function setupUi() {
    roundManager.start()
    playerSessionManager.start()
    ReactEcsRenderer.setUiRenderer(uiMenu, { virtualWidth: 1920, virtualHeight: 1080 })
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

// draw your UI here
export const uiMenu = () => {
    const session = playerSessionManager.getSnapshot()
    const round = roundManager.getSnapshot()

    return (
        // Keeps the panel clear of the device notch, status bar and rounded corners on mobile
        <ScreenInsetArea>
            {/* Persistent Social HUD - visible everywhere in the scene, independent of Quest Zone/join/round state.
                Top-center: native Decentraland UI occupies top-left (and sometimes top-right), so this full-width,
                top-anchored band with a horizontally-centered child is the only corner-independent safe spot. */}
            <UiEntity
                uiTransform={{
                    positionType: 'absolute',
                    position: { top: 24 },
                    width: '100%',
                    flexDirection: 'column',
                    alignItems: 'center'
                }}
            >
                <SocialHud />
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
const SocialHud = () => {
    const total = getTotalConnections()

    if (!socialHudExpanded) {
        return (
            <UiEntity
                uiTransform={{ flexDirection: 'row', alignItems: 'center', padding: { top: 10, bottom: 10, left: 16, right: 16 } }}
                uiBackground={{ color: PANEL_BACKGROUND }}
                onMouseDown={() => {
                    socialHudExpanded = true
                }}
            >
                <Label value={`CONNECTIONS  ${total}`} fontSize={20} color={Color4.White()} uiTransform={{ margin: { right: 8 } }} />
                <Label value="▼" fontSize={16} color={MUTED} />
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
        <UiEntity uiTransform={{ flexDirection: 'column', width: 280, padding: 20 }} uiBackground={{ color: PANEL_BACKGROUND }}>
            <UiEntity
                uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', margin: { bottom: 14 } }}
                onMouseDown={() => {
                    socialHudExpanded = false
                }}
            >
                <Label value="MY SOCIAL QUEST" fontSize={18} color={Color4.create(1, 0.85, 0.2, 1)} />
                <Label value="▲" fontSize={16} color={MUTED} />
            </UiEntity>

            <Label value="CONNECTIONS" fontSize={14} color={MUTED} uiTransform={{ margin: { bottom: 4 } }} />
            <Label value={`${total}`} fontSize={28} color={Color4.White()} uiTransform={{ margin: { bottom: 16 } }} />

            {recentLabels.length > 0 && (
                <UiEntity uiTransform={{ width: '100%', flexDirection: 'column' }}>
                    <Label value="RECENT CONNECTIONS" fontSize={14} color={MUTED} uiTransform={{ margin: { bottom: 6 } }} />
                    {recentUserIds.map((userId, index) => (
                        <Label
                            key={userId}
                            value={recentLabels[index]}
                            fontSize={18}
                            color={Color4.White()}
                            uiTransform={{ margin: { bottom: 4 } }}
                        />
                    ))}
                </UiEntity>
            )}
        </UiEntity>
    )
}
