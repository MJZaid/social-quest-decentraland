import { SharedPhase, RoundStateValue } from './networkRoundState'
import { getNewConnectionsFromLastRound, getTotalConnections } from './connectionsManager'

/** How many round ticks (~seconds) a celebration stays visible once triggered. */
const CELEBRATION_TICKS = 3

export interface CelebrationSnapshot {
    newUserIds: string[]
    totalBefore: number
    totalAfter: number
}

interface ActiveCelebration extends CelebrationSnapshot {
    roundId: number
}

let activeCelebration: ActiveCelebration | null = null
let ticksRemaining = 0
/**
 * The roundId whose celebration has already been STARTED, kept even after the card
 * expires (activeCelebration becomes null). Without this, an expired celebration would
 * be indistinguishable from "never started", and a still-non-empty
 * getNewConnectionsFromLastRound() on a later RESULT tick of the SAME round would
 * incorrectly start a second one. Never reset by expiry or by the ANSWERING-clear -
 * only ever overwritten when a genuinely different round starts its own celebration.
 */
let lastCelebrationStartedRoundId: number | null = null

/**
 * Local-presentation-only celebration derived from connectionsManager's existing read
 * API - no synchronized reward component, no new relationship logic. Called from
 * RoundManager.tick() (same 1s cadence already driving Connections processing).
 *
 * Gameplay always has priority: the moment a new ANSWERING phase is observed, any
 * active celebration is cleared immediately, mirroring the AFK message's own rule.
 */
export function tick(state: RoundStateValue): void {
    if (state.phase === SharedPhase.ANSWERING) {
        if (activeCelebration !== null) {
            activeCelebration = null
            ticksRemaining = 0
        }
        return
    }

    if (state.phase !== SharedPhase.RESULT) return // WAITING: nothing to celebrate

    const newUserIds = getNewConnectionsFromLastRound()

    if (newUserIds.length > 0) {
        const totalAfter = getTotalConnections()
        const totalBefore = totalAfter - newUserIds.length

        if (activeCelebration !== null && activeCelebration.roundId === state.roundId) {
            // Same round's celebration, already running: refresh in place so a late
            // synchronized answer updates the same card instead of creating a new one.
            // The lifetime timer is NOT reset by this - it keeps counting down from when
            // the celebration first appeared.
            activeCelebration.newUserIds = newUserIds
            activeCelebration.totalBefore = totalBefore
            activeCelebration.totalAfter = totalAfter
        } else if (lastCelebrationStartedRoundId !== state.roundId) {
            // This round has never started a celebration before - not even one that has
            // since expired. Start exactly one.
            activeCelebration = { roundId: state.roundId, newUserIds, totalBefore, totalAfter }
            ticksRemaining = CELEBRATION_TICKS
            lastCelebrationStartedRoundId = state.roundId
        }
        // else: this round already had its one celebration and it has since expired - stay cleared.
    }

    if (activeCelebration !== null) {
        ticksRemaining -= 1
        if (ticksRemaining <= 0) {
            activeCelebration = null
        }
    }
}

export function getCelebrationSnapshot(): CelebrationSnapshot | null {
    if (activeCelebration === null) return null
    return { newUserIds: activeCelebration.newUserIds, totalBefore: activeCelebration.totalBefore, totalAfter: activeCelebration.totalAfter }
}
