import { SharedPhase, RoundStateValue } from './networkRoundState'
import { getFriendshipLevelUpsFromLastTick, FriendshipLevel, FriendshipLevelUpEvent } from './friendshipManager'

/**
 * How many round ticks (~seconds) a celebration stays visible once triggered.
 * Longer than NEW CONNECTION's lifetime (see connectionCelebration.ts) since this
 * card carries more information to read (partner name(s), level, rounds together)
 * and the event itself is rarer/more meaningful.
 */
export const CELEBRATION_TICKS = 6

/**
 * Presentation-only summary of the currently active Friendship celebration.
 * `level`/`roundsTogether` are non-null only when every included partner reached
 * the SAME new level this celebration - if simultaneous crossings landed on
 * different levels, both stay null and the UI falls back to a generic summary
 * rather than trying to show several levels/counts on one card.
 */
export interface FriendshipCelebrationSnapshot {
    /** Stable identity for this celebration instance - lets a consumer (e.g. socialCelebrationQueue.ts) dedupe/merge without re-deriving round-awareness itself. */
    roundId: number
    userIds: string[]
    level: FriendshipLevel | null
    roundsTogether: number | null
}

interface ActiveFriendshipCelebration extends FriendshipCelebrationSnapshot {
    roundId: number
    /** Raw accumulated events for this round - kept so a later-arriving partner's crossing can be merged back into a fresh derived snapshot instead of only ever unioning userIds. */
    events: FriendshipLevelUpEvent[]
}

let activeCelebration: ActiveFriendshipCelebration | null = null
let ticksRemaining = 0
/**
 * The roundId whose Friendship celebration has already been STARTED, kept even
 * after the card expires. Mirrors connectionCelebration.ts's own
 * lastCelebrationStartedRoundId: visual lifetime (activeCelebration/ticksRemaining)
 * and "already started for this round" bookkeeping are deliberately separate, so an
 * expired card can never be reopened by the same round's data.
 */
let lastCelebrationStartedRoundId: number | null = null

function buildSnapshot(events: FriendshipLevelUpEvent[]): Omit<FriendshipCelebrationSnapshot, 'roundId'> {
    const userIds = events.map((event) => event.otherUserId)
    const uniqueLevels = new Set(events.map((event) => event.newLevel))

    if (uniqueLevels.size === 1) {
        return { userIds, level: events[0].newLevel, roundsTogether: events[0].roundsTogether }
    }
    // Mixed levels in the same batch - safe generic summary, no per-partner detail.
    return { userIds, level: null, roundsTogether: null }
}

/**
 * Local-presentation-only celebration derived from friendshipManager's existing
 * read API - no new relationship/threshold logic. Must run in the same tick as
 * (and after) evaluateFriendshipLevels(), since getFriendshipLevelUpsFromLastTick()
 * only reflects the most recent evaluation - see roundManager.tick() wiring.
 *
 * Gameplay always has priority: the moment a new ANSWERING phase is observed, any
 * active celebration is cleared immediately, mirroring NEW CONNECTION's own rule.
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

    const newEvents = getFriendshipLevelUpsFromLastTick()

    if (newEvents.length > 0) {
        if (activeCelebration !== null && activeCelebration.roundId === state.roundId) {
            // Same round, already running: a different partner's crossing landed on a
            // later RESULT tick (e.g. a late answer) - merge into the same card instead
            // of starting a second one. Lifetime timer is NOT reset by this.
            const mergedEvents = [...activeCelebration.events, ...newEvents]
            const snapshot = buildSnapshot(mergedEvents)
            activeCelebration.events = mergedEvents
            activeCelebration.userIds = snapshot.userIds
            activeCelebration.level = snapshot.level
            activeCelebration.roundsTogether = snapshot.roundsTogether
        } else if (lastCelebrationStartedRoundId !== state.roundId) {
            // This round has never started a Friendship celebration before - not even
            // one that has since expired. Start exactly one.
            const snapshot = buildSnapshot(newEvents)
            activeCelebration = { roundId: state.roundId, events: newEvents, ...snapshot }
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

export function getFriendshipCelebrationSnapshot(): FriendshipCelebrationSnapshot | null {
    if (activeCelebration === null) return null
    return {
        roundId: activeCelebration.roundId,
        userIds: activeCelebration.userIds,
        level: activeCelebration.level,
        roundsTogether: activeCelebration.roundsTogether
    }
}
