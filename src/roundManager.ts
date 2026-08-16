import { isStateSyncronized, myProfile } from '@dcl/sdk/network'
import { Question, QUESTIONS, getQuestionIndexForRound } from './questions'
import { MIN_PLAYERS_REQUIRED } from './playerManager'
import { getRoundState, writeRoundState, startRoundStateSync, SharedPhase, NO_QUESTION, NO_COORDINATOR, RoundStateValue } from './networkRoundState'
import { getActiveUserIds } from './networkPlayerSession'
import {
    AnswerOption,
    PlayerAnswerValue,
    startPlayerAnswerSync,
    publishPlayerAnswer,
    getAnswersForRound,
    getDisplayName
} from './networkPlayerAnswer'

export type Option = 'A' | 'B'
export type RoundPhase = 'waiting' | 'answering' | 'result'

export interface RevealEntry {
    userId: string
    name: string
    option: Option | null
}

export interface RevealData {
    entries: RevealEntry[]
    countA: number
    countB: number
}

export interface RoundSnapshot {
    phase: RoundPhase
    /** True when this client has joined but is not yet ACTIVE for the current round (pending until next round). */
    isPending: boolean
    /** True while this client hasn't finished its initial CRDT state hydration yet. */
    isSyncing: boolean
    /** Non-spectating... i.e. active-eligible player count snapshotted for the current round. */
    activeParticipantCount: number
    question: Question | null
    selectedOption: Option | null
    secondsLeft: number
    /** True while RESULT is still waiting on expected answers (or the short timeout). */
    isRevealing: boolean
    /** Live-recomputed every read - never a frozen one-time snapshot. */
    reveal: RevealData | null
}

const ANSWERING_SECONDS = 10
const RESULT_SECONDS = 3
/** How long into RESULT we keep waiting for missing answers before revealing anyway. */
const REVEAL_TIMEOUT_SECONDS = 1

function phaseDuration(phase: SharedPhase): number {
    return phase === SharedPhase.ANSWERING ? ANSWERING_SECONDS : RESULT_SECONDS
}

function toLocalPhase(phase: SharedPhase): RoundPhase {
    if (phase === SharedPhase.ANSWERING) return 'answering'
    if (phase === SharedPhase.RESULT) return 'result'
    return 'waiting'
}

/** The round relevant to eligibility checks right now: the round in flight, or the one about to start if WAITING. */
function relevantRoundId(state: RoundStateValue): number {
    return state.phase === SharedPhase.WAITING ? state.roundId + 1 : state.roundId
}

function buildRevealData(answers: PlayerAnswerValue[]): RevealData {
    const entries: RevealEntry[] = answers.map((answer) => ({
        userId: answer.userId,
        name: getDisplayName(answer.userId),
        option: answer.option === AnswerOption.A ? 'A' : answer.option === AnswerOption.B ? 'B' : null
    }))
    const countA = entries.filter((entry) => entry.option === 'A').length
    const countB = entries.filter((entry) => entry.option === 'B').length
    return { entries, countA, countB }
}

/**
 * Single deterministic coordinator, no server: exactly one synchronized, currently
 * ACTIVE (joined and eligible for the relevant round) client - the
 * lexicographically-smallest active userId - is ever allowed to advance RoundState.
 * Everyone else only reads and displays it. Coordinator identity itself lives in
 * RoundState.coordinatorId (not local belief), so late joiners can never disagree
 * with already-present clients about who is coordinating.
 *
 * "Active" (see networkPlayerSession.ts) replaces the old presence-based eligibility:
 * a player must have pressed JOIN and be eligible for the round in question - merely
 * being present in the scene, in the Quest Zone, or joined-but-pending for a future
 * round is not enough to answer, be counted, or coordinate.
 *
 * Everything else in this class is LOCAL/private to this client: the selected answer.
 */
class RoundManager {
    private intervalId: number | null = null

    private selectedOption: Option | null = null
    private lastObservedRoundId: number | null = null

    /** roundId this client has already published its own PlayerAnswer for (publish-once guard). */
    private publishedForRoundId: number | null = null

    /** Starts the shared-state sync and the local tick loop. Safe to call more than once. */
    start(): void {
        if (this.intervalId !== null) return
        startRoundStateSync()
        startPlayerAnswerSync()
        this.intervalId = setInterval(() => this.tick(), 1000)
    }

    selectOption(option: Option): void {
        if (!isStateSyncronized()) return
        const state = getRoundState()
        if (state.phase !== SharedPhase.ANSWERING) return
        if (!getActiveUserIds(state.roundId).includes(myProfile.userId)) return
        if (this.selectedOption !== null) return
        this.selectedOption = option
    }

    getSnapshot(): RoundSnapshot {
        if (!isStateSyncronized()) {
            return {
                phase: 'waiting',
                isPending: false,
                isSyncing: true,
                activeParticipantCount: 0,
                question: null,
                selectedOption: null,
                secondsLeft: 0,
                isRevealing: false,
                reveal: null
            }
        }

        const state = getRoundState()
        const question = state.questionIndex === NO_QUESTION ? null : QUESTIONS[state.questionIndex]
        const isActiveNow = getActiveUserIds(state.roundId).includes(myProfile.userId)

        let isRevealing = false
        let reveal: RevealData | null = null
        if (state.phase === SharedPhase.RESULT) {
            const answers = getAnswersForRound(state.roundId)
            const elapsedInResult = RESULT_SECONDS - state.secondsLeft
            const haveAllExpected = state.participantCount > 0 && answers.length >= state.participantCount
            const timedOut = elapsedInResult >= REVEAL_TIMEOUT_SECONDS
            if (haveAllExpected || timedOut) {
                reveal = buildRevealData(answers)
            } else {
                isRevealing = true
            }
        }

        // During WAITING, state.participantCount is only the last round's stale snapshot (or 0) -
        // show the live count of who is actually eligible for the round about to start instead.
        // During ANSWERING/RESULT, keep using the snapshot: it must stay fixed for reveal-readiness.
        const activeParticipantCount =
            state.phase === SharedPhase.WAITING ? getActiveUserIds(relevantRoundId(state)).length : state.participantCount

        return {
            phase: toLocalPhase(state.phase),
            isPending: state.phase !== SharedPhase.WAITING && !isActiveNow,
            isSyncing: false,
            activeParticipantCount,
            question,
            selectedOption: this.selectedOption,
            secondsLeft: state.secondsLeft,
            isRevealing,
            reveal
        }
    }

    private tick(): void {
        if (!isStateSyncronized()) return // Not synced yet: never write, never publish.

        const state = getRoundState()
        const eligibleUserIds = getActiveUserIds(relevantRoundId(state))
        const stateAfterElection = this.maybeElectCoordinator(state, eligibleUserIds)
        const amICoordinator = stateAfterElection.coordinatorId === myProfile.userId

        this.syncLocalBookkeeping(stateAfterElection)
        this.maybePublishAnswer(stateAfterElection)

        if (!amICoordinator) return // Followers never write round/timer state.

        this.runCoordinatorLogic(stateAfterElection, eligibleUserIds.length)
    }

    /**
     * Elects a coordinator whenever the currently synced one is missing or no longer
     * ACTIVE for the relevant round. Any synchronized client may perform this write
     * (not just the elected one) - safe because every client computes the identical
     * deterministic target value. Never touches roundId/phase/questionIndex/secondsLeft,
     * so it can never reset an in-progress round.
     */
    private maybeElectCoordinator(state: RoundStateValue, eligibleUserIds: string[]): RoundStateValue {
        const coordinatorValid = state.coordinatorId !== NO_COORDINATOR && eligibleUserIds.includes(state.coordinatorId)
        if (coordinatorValid || eligibleUserIds.length === 0) return state

        const electedId = eligibleUserIds.slice().sort()[0]
        if (state.coordinatorId === electedId) return state

        const nextState = { ...state, coordinatorId: electedId }
        writeRoundState(nextState)
        return nextState
    }

    /** Runs the round lifecycle. Only ever invoked when this client IS the coordinator. */
    private runCoordinatorLogic(state: RoundStateValue, eligibleCount: number): void {
        if (eligibleCount < MIN_PLAYERS_REQUIRED) {
            if (state.phase !== SharedPhase.WAITING) {
                this.selectedOption = null
                writeRoundState({
                    ...state,
                    phase: SharedPhase.WAITING,
                    questionIndex: NO_QUESTION,
                    secondsLeft: 0,
                    participantCount: 0
                })
            }
            return
        }

        if (state.phase === SharedPhase.WAITING) {
            this.startNewRound(state)
            return
        }

        if (state.secondsLeft > 0) {
            writeRoundState({ ...state, secondsLeft: state.secondsLeft - 1 })
            return
        }

        if (state.phase === SharedPhase.ANSWERING) {
            writeRoundState({ ...state, phase: SharedPhase.RESULT, secondsLeft: RESULT_SECONDS })
        } else {
            this.startNewRound(state)
        }
    }

    private startNewRound(state: RoundStateValue): void {
        const nextRoundId = state.roundId + 1
        const participantCount = getActiveUserIds(nextRoundId).length
        this.selectedOption = null
        writeRoundState({
            ...state,
            roundId: nextRoundId,
            phase: SharedPhase.ANSWERING,
            questionIndex: getQuestionIndexForRound(nextRoundId),
            secondsLeft: phaseDuration(SharedPhase.ANSWERING),
            participantCount
        })
    }

    /** Local-only bookkeeping every client runs regardless of coordinator role: clearing the private answer on a new round. */
    private syncLocalBookkeeping(state: RoundStateValue): void {
        if (state.roundId !== this.lastObservedRoundId) {
            this.selectedOption = null
            this.lastObservedRoundId = state.roundId
        }
    }

    /** Publishes this client's own answer exactly once, the first tick RESULT is observed for this round - only if ACTIVE for it. */
    private maybePublishAnswer(state: RoundStateValue): void {
        if (state.phase !== SharedPhase.RESULT) return
        if (!getActiveUserIds(state.roundId).includes(myProfile.userId)) return
        if (this.publishedForRoundId === state.roundId) return
        this.publishedForRoundId = state.roundId

        const option =
            this.selectedOption === 'A' ? AnswerOption.A : this.selectedOption === 'B' ? AnswerOption.B : AnswerOption.NO_ANSWER
        publishPlayerAnswer(state.roundId, option)
    }
}

/** Single instance for the whole session - the round loop never restarts due to UI re-renders. */
export const roundManager = new RoundManager()
