import { myProfile } from '@dcl/sdk/network'
import { SharedPhase, RoundStateValue } from './networkRoundState'
import { AnswerOption, getAnswersForRound } from './networkPlayerAnswer'

/** Public, UI-facing view of a relationship - no internal bookkeeping exposed. */
export interface ConnectionRecord {
    otherUserId: string
    roundsTogether: number
    sameAnswers: number
    differentAnswers: number
}

/** Internal record: same as ConnectionRecord plus the bounded per-relationship dedup marker. */
interface InternalConnection extends ConnectionRecord {
    /** roundId this relationship was last incremented for - prevents double-counting a rescanned round. */
    lastProcessedRoundId: number
}

/** This client's own connections only - keyed by the other player's userId. One entry per unique partner ever met, not per round. */
const connections = new Map<string, InternalConnection>()

/** The round whose RESULT window newConnectionsThisRound currently reflects. */
let currentRoundId: number | null = null
/** Unique new partners accumulated across every RESULT tick of currentRoundId - late arrivals get appended, not just the first tick's set. */
let newConnectionsThisRound: string[] = []

/**
 * Re-evaluates this client's own Connections for the current round on every RESULT
 * tick (called from RoundManager.tick(), reusing its existing 1s cadence - no new
 * timer). Deriving purely from getAnswersForRound(): no synced schema change.
 *
 * O(N) per tick, not O(N^2): only pairs (localUserId, otherUserId) are ever computed -
 * never the full mesh between other players, since this client only needs to know
 * about relationships that involve itself. Every other client independently does the
 * same for its own userId; together this covers the full social graph without any
 * client having to compute or discard pairs that aren't its own.
 */
export function processRoundState(state: RoundStateValue): void {
    if (state.phase !== SharedPhase.RESULT) return

    if (state.roundId !== currentRoundId) {
        currentRoundId = state.roundId
        newConnectionsThisRound = []
    }

    const answers = getAnswersForRound(state.roundId)
    const myAnswer = answers.find((answer) => answer.userId === myProfile.userId && answer.option !== AnswerOption.NO_ANSWER)
    if (!myAnswer) return // I didn't answer this round - nothing to process

    for (const other of answers) {
        if (other.userId === myProfile.userId) continue
        if (other.option === AnswerOption.NO_ANSWER) continue

        const isNew = recordRound(other.userId, state.roundId, myAnswer.option, other.option)
        if (isNew) newConnectionsThisRound.push(other.userId)
    }
}

/**
 * Increments the relationship with `otherUserId` for `roundId` exactly once, no matter
 * how many times this round gets rescanned as late answers arrive. Bounded bookkeeping:
 * one lastProcessedRoundId per unique partner, not one marker per round ever played.
 * Returns true only the first time this partner is ever recorded (a brand new Connection).
 */
function recordRound(otherUserId: string, roundId: number, myOption: AnswerOption, otherOption: AnswerOption): boolean {
    const existing = connections.get(otherUserId)
    if (existing && existing.lastProcessedRoundId === roundId) return false // already counted this round for this partner

    const isNew = !existing
    const record: InternalConnection = existing ?? { otherUserId, roundsTogether: 0, sameAnswers: 0, differentAnswers: 0, lastProcessedRoundId: -1 }

    record.roundsTogether += 1
    if (myOption === otherOption) {
        record.sameAnswers += 1
    } else {
        record.differentAnswers += 1
    }
    record.lastProcessedRoundId = roundId

    connections.set(otherUserId, record)
    return isNew
}

export function getTotalConnections(): number {
    return connections.size
}

/** Unique new partners from the most recently processed round's RESULT window - accumulates as late answers arrive, not just the first tick's set. */
export function getNewConnectionsFromLastRound(): string[] {
    return [...newConnectionsThisRound]
}

export function getConnection(otherUserId: string): ConnectionRecord | null {
    const record = connections.get(otherUserId)
    if (!record) return null
    return { otherUserId: record.otherUserId, roundsTogether: record.roundsTogether, sameAnswers: record.sameAnswers, differentAnswers: record.differentAnswers }
}

export function getAllConnections(): ConnectionRecord[] {
    return Array.from(connections.values()).map((record) => ({
        otherUserId: record.otherUserId,
        roundsTogether: record.roundsTogether,
        sameAnswers: record.sameAnswers,
        differentAnswers: record.differentAnswers
    }))
}
