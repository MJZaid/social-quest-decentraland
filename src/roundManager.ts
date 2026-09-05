import { isStateSyncronized, myProfile } from '@dcl/sdk/network'
import { Question, QUESTIONS, getQuestionIndexForRound } from './questions'
import { MIN_PLAYERS_REQUIRED } from './playerManager'
import { getRoundState, writeRoundState, startRoundStateSync, SharedPhase, NO_QUESTION, NO_COORDINATOR, RoundStateValue } from './networkRoundState'
import { getActiveUserIds, setJoined } from './networkPlayerSession'
import { processRoundState } from './connectionsManager'
import { tick as tickConnectionCelebration } from './connectionCelebration'
import { evaluateFriendshipLevels } from './friendshipManager'
import { tick as tickFriendshipCelebration } from './friendshipCelebration'
import { tick as tickSocialCelebrationQueue } from './socialCelebrationQueue'
import { tickPersistenceLoad, tickPersistenceCapture } from './persistenceManager'
import {
    AnswerOption,
    PlayerAnswerValue,
    startPlayerAnswerSync,
    publishPlayerAnswer,
    getAnswersForRound,
    getDisplayName
} from './networkPlayerAnswer'

export type Option = 'A' | 'B'
export type RoundPhase = 'waiting' | 'countdown' | 'answering' | 'result'

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
    /** Transient local AFK notice: 'warning' after 1 missed round, 'removed' right after auto-unjoin on the 2nd. */
    afkMessage: 'warning' | 'removed' | null
}

const ANSWERING_SECONDS = 10
const RESULT_SECONDS = 3
/** Pre-round countdown once quorum is met - WAITING/COUNTDOWN only, never between ANSWERING rounds. */
const COUNTDOWN_SECONDS = 3
/** How long into RESULT we keep waiting for missing answers before revealing anyway. */
const REVEAL_TIMEOUT_SECONDS = 1
/** How many consecutive missed eligible rounds trigger automatic unjoin. */
const MAX_CONSECUTIVE_MISSES = 2
/** How long (in round ticks, ~seconds) a transient AFK message stays visible. */
const AFK_MESSAGE_TICKS = 3

function phaseDuration(phase: SharedPhase): number {
    return phase === SharedPhase.ANSWERING ? ANSWERING_SECONDS : RESULT_SECONDS
}

function toLocalPhase(phase: SharedPhase): RoundPhase {
    if (phase === SharedPhase.ANSWERING) return 'answering'
    if (phase === SharedPhase.RESULT) return 'result'
    if (phase === SharedPhase.COUNTDOWN) return 'countdown'
    return 'waiting'
}

/**
 * The round relevant to eligibility checks right now: the round in flight, or
 * the one about to start if WAITING or COUNTDOWN. roundId itself does NOT
 * advance until COUNTDOWN finishes and ANSWERING actually begins (see
 * startNewRound) - COUNTDOWN is deliberately just "WAITING with quorum met
 * and a visible timer" for eligibility purposes, so a player's
 * eligibleFromRoundId is always evaluated against the same round number
 * throughout the whole WAITING->COUNTDOWN stretch, never shifted by entering
 * or being mid-countdown.
 */
function relevantRoundId(state: RoundStateValue): number {
    return state.phase === SharedPhase.WAITING || state.phase === SharedPhase.COUNTDOWN ? state.roundId + 1 : state.roundId
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
    /** The roundId `selectedOption` was actually chosen for - lets getSnapshot() reject a stale selection the instant state.roundId advances, without depending on the ~1s tick loop having already run syncLocalBookkeeping()'s reset. */
    private selectedOptionRoundId: number | null = null
    private lastObservedRoundId: number | null = null
    private lastObservedPhase: SharedPhase | null = null

    /**
     * The roundId this client was ACTIVE for at the moment it first observed that round
     * starting - frozen from then on, deliberately never re-derived from `joined` again.
     * `joined` still governs eligibility for FUTURE rounds (see getActiveUserIds), but once a
     * round has actually started, leaving the Quest Zone must not retroactively strip this
     * client's own participation in it - see maybePublishAnswer(), the only reader.
     */
    private participatingRoundId: number | null = null

    /** roundId this client has already published its own PlayerAnswer for (publish-once guard). */
    private publishedForRoundId: number | null = null

    /** AFK tracking - purely local, never synced: each client enforces only its own inactivity. */
    private consecutiveMissedRounds = 0
    private afkEvaluatedForRoundId: number | null = null
    private afkMessage: 'warning' | 'removed' | null = null
    private afkMessageTicksRemaining = 0

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
        this.selectedOptionRoundId = state.roundId
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
                reveal: null,
                afkMessage: null
            }
        }

        const state = getRoundState()
        const question = state.questionIndex === NO_QUESTION ? null : QUESTIONS[state.questionIndex]
        // relevantRoundId(), not the raw state.roundId: during COUNTDOWN, roundId hasn't
        // advanced yet (see relevantRoundId's own doc comment), but eligibility must already
        // be checked against the round that's about to start - otherwise a player who only
        // just became eligible would wrongly show as "pending" (isPending below) throughout
        // the countdown they're actually part of. For ANSWERING/RESULT this is a no-op:
        // relevantRoundId() already returns state.roundId unchanged there.
        const isActiveNow = getActiveUserIds(relevantRoundId(state)).includes(myProfile.userId)
        // A selection only belongs to the round it was made for. this.selectedOption is only
        // reset to null by the ~1s tick loop (syncLocalBookkeeping), but getSnapshot() can be
        // read by the UI many times per second and state.roundId can already reflect a new
        // round before that reset runs - without this check, a stale 'A'/'B' from the PREVIOUS
        // round could be paired with the NEW round's question, wrongly rendering it as already
        // answered.
        const selectedOption = this.selectedOptionRoundId === state.roundId ? this.selectedOption : null

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
            selectedOption,
            secondsLeft: state.secondsLeft,
            isRevealing,
            reveal,
            afkMessage: this.afkMessage
        }
    }

    private tick(): void {
        if (!isStateSyncronized()) return // Not synced yet: never write, never publish.

        if (this.afkMessage !== null) {
            this.afkMessageTicksRemaining -= 1
            if (this.afkMessageTicksRemaining <= 0) {
                this.afkMessage = null
            }
        }

        const state = getRoundState()
        const eligibleUserIds = getActiveUserIds(relevantRoundId(state))
        const stateAfterElection = this.maybeElectCoordinator(state, eligibleUserIds)
        const amICoordinator = stateAfterElection.coordinatorId === myProfile.userId

        this.syncLocalBookkeeping(stateAfterElection)
        this.maybePublishAnswer(stateAfterElection)
        processRoundState(stateAfterElection)
        evaluateFriendshipLevels()
        tickFriendshipCelebration(stateAfterElection)
        tickConnectionCelebration(stateAfterElection)
        // Deliberately unconditional (no phase check, no state argument) - the queue must
        // keep capturing/advancing regardless of round phase so a captured celebration is
        // never lost just because the round moves on to ANSWERING while it's still queued.
        tickSocialCelebrationQueue()
        // Persistence side channel (LOAD only - see persistenceManager.ts). Never
        // gates or delays anything above; both are no-ops once their own
        // one-time condition has already fired (profile requested / hydrated).
        tickPersistenceLoad()
        tickPersistenceCapture(stateAfterElection)

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

    /**
     * Runs the round lifecycle. Only ever invoked when this client IS the coordinator.
     *
     * WAITING/COUNTDOWN require quorum (>= MIN_PLAYERS_REQUIRED) to proceed - losing it
     * cancels a countdown or simply keeps WAITING. ANSWERING/RESULT are the opposite: once a
     * round has actually started, it always runs to completion regardless of eligibleCount -
     * a player leaving the Quest Zone mid-round affects their eligibility for FUTURE rounds,
     * never retroactively invalidates the one already in flight (that round's own answers/
     * reveal are handled entirely by the existing PlayerAnswer/timeout machinery, untouched
     * here). Quorum is only re-checked for the round that would come NEXT, inside
     * startNewRound() - see its own doc comment for why that can't reuse this eligibleCount.
     */
    private runCoordinatorLogic(state: RoundStateValue, eligibleCount: number): void {
        if (state.phase === SharedPhase.WAITING || state.phase === SharedPhase.COUNTDOWN) {
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
                // Quorum just met - start the pre-round countdown instead of the round itself.
                // roundId is deliberately left untouched here (see relevantRoundId's doc comment).
                writeRoundState({ ...state, phase: SharedPhase.COUNTDOWN, secondsLeft: COUNTDOWN_SECONDS })
                return
            }

            // COUNTDOWN, quorum still held this tick. Dedicated branch, not the generic
            // secondsLeft-- below: transitions to ANSWERING the instant secondsLeft would hit
            // 1->0, so the UI shows exactly 3/2/1 with no trailing "0" frame before the
            // question appears (unlike ANSWERING/RESULT's own countdowns, which do show a
            // final 0 - not changed here, only COUNTDOWN's).
            if (state.secondsLeft > 1) {
                writeRoundState({ ...state, secondsLeft: state.secondsLeft - 1 })
            } else {
                this.startNewRound(state)
            }
            return
        }

        // ANSWERING or RESULT: a round already in flight runs to completion no matter what
        // eligibleCount does in the meantime - see this method's doc comment.
        if (state.secondsLeft > 0) {
            writeRoundState({ ...state, secondsLeft: state.secondsLeft - 1 })
            return
        }

        if (state.phase === SharedPhase.ANSWERING) {
            writeRoundState({ ...state, phase: SharedPhase.RESULT, secondsLeft: RESULT_SECONDS })
        } else {
            // RESULT finished - startNewRound() itself decides whether quorum holds for the
            // next round (roundId + 1) or this bounces back to WAITING instead.
            this.startNewRound(state)
        }
    }

    /**
     * Starts the next round (from WAITING/COUNTDOWN's very first round, from COUNTDOWN
     * finishing, or from RESULT finishing) - OR bounces to WAITING instead if quorum no
     * longer holds for it. Deliberately re-checks eligibility here against `nextRoundId`
     * rather than trusting the caller's own `eligibleCount`: when called after RESULT, that
     * value was computed against the round that just ENDED (relevantRoundId() only adds +1
     * during WAITING/COUNTDOWN), which can disagree with nextRoundId's real eligibility - e.g.
     * a player who joined mid-RESULT is eligible for nextRoundId but wouldn't have counted
     * against the round that's ending. This is the single place that decides "is there
     * quorum for the round about to start", used identically by both callers.
     */
    private startNewRound(state: RoundStateValue): void {
        const nextRoundId = state.roundId + 1
        const participantCount = getActiveUserIds(nextRoundId).length
        this.selectedOption = null

        if (participantCount < MIN_PLAYERS_REQUIRED) {
            writeRoundState({ ...state, phase: SharedPhase.WAITING, questionIndex: NO_QUESTION, secondsLeft: 0, participantCount: 0 })
            return
        }

        writeRoundState({
            ...state,
            roundId: nextRoundId,
            phase: SharedPhase.ANSWERING,
            questionIndex: getQuestionIndexForRound(nextRoundId),
            secondsLeft: phaseDuration(SharedPhase.ANSWERING),
            participantCount
        })
    }

    /**
     * Local-only bookkeeping every client runs regardless of coordinator role: clearing
     * the private answer on a new round, and evaluating this client's own AFK status the
     * moment it observes its own round's normal ANSWERING -> RESULT transition (same
     * roundId). ANSWERING can no longer abort straight back to WAITING (a round in flight
     * always reaches RESULT now, regardless of eligibleCount - see runCoordinatorLogic's own
     * doc comment) - the only remaining WAITING-bound transitions are WAITING/COUNTDOWN
     * losing quorum before a round starts, or RESULT ending with no quorum for the next one
     * (via startNewRound), neither of which is an "ANSWERING just ended" case this method
     * needs to special-case.
     */
    private syncLocalBookkeeping(state: RoundStateValue): void {
        const isNewRound = state.roundId !== this.lastObservedRoundId
        const answeringJustEnded =
            !isNewRound && this.lastObservedPhase === SharedPhase.ANSWERING && state.phase === SharedPhase.RESULT

        if (answeringJustEnded) {
            this.evaluateAfkForRound(state.roundId)
        }

        if (isNewRound) {
            this.selectedOption = null
            this.lastObservedRoundId = state.roundId
            // Never let a transient AFK notice linger into a new round's answer buttons.
            this.afkMessage = null
            this.afkMessageTicksRemaining = 0
            // Freeze participation for this round, right now, based on eligibility at this
            // exact moment - see participatingRoundId's own doc comment. Deliberately the
            // only place this is (re)computed; nothing else ever revisits it for this roundId.
            this.participatingRoundId = getActiveUserIds(state.roundId).includes(myProfile.userId) ? state.roundId : null
        }
        this.lastObservedPhase = state.phase
    }

    /**
     * Counts a miss only if this client was ACTIVE (joined and eligible) for `roundId` and
     * had not answered by the time its ANSWERING phase ended. Evaluated at most once per
     * round. Answering resets the streak; 2 consecutive misses auto-unjoin via the same
     * setJoined() primitive the Quest Zone exit already uses - no shared AFK authority,
     * no inference about remote players.
     */
    private evaluateAfkForRound(roundId: number): void {
        if (this.afkEvaluatedForRoundId === roundId) return
        this.afkEvaluatedForRoundId = roundId

        if (!getActiveUserIds(roundId).includes(myProfile.userId)) return // wasn't active for this round - never a miss

        if (this.selectedOption !== null) {
            this.consecutiveMissedRounds = 0
            return
        }

        this.consecutiveMissedRounds += 1
        if (this.consecutiveMissedRounds >= MAX_CONSECUTIVE_MISSES) {
            this.consecutiveMissedRounds = 0
            setJoined(false)
            this.showAfkMessage('removed')
        } else {
            this.showAfkMessage('warning')
        }
    }

    private showAfkMessage(message: 'warning' | 'removed'): void {
        this.afkMessage = message
        this.afkMessageTicksRemaining = AFK_MESSAGE_TICKS
    }

    /**
     * Publishes this client's own answer exactly once, the first tick RESULT is observed for
     * this round - only if this client was a PARTICIPANT of this specific round (frozen at
     * the moment it started - see participatingRoundId's own doc comment), not whether it's
     * currently `joined`/active right now. A player who left the Quest Zone mid-round still
     * publishes their real A/B choice (or NO_ANSWER) here; a spectator who was never part of
     * this round still correctly never does.
     */
    private maybePublishAnswer(state: RoundStateValue): void {
        if (state.phase !== SharedPhase.RESULT) return
        if (this.participatingRoundId !== state.roundId) return
        if (this.publishedForRoundId === state.roundId) return
        this.publishedForRoundId = state.roundId

        const option =
            this.selectedOption === 'A' ? AnswerOption.A : this.selectedOption === 'B' ? AnswerOption.B : AnswerOption.NO_ANSWER
        publishPlayerAnswer(state.roundId, option)
    }
}

/** Single instance for the whole session - the round loop never restarts due to UI re-renders. */
export const roundManager = new RoundManager()
