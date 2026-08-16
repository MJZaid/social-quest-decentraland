import { engine, Transform } from '@dcl/sdk/ecs'
import { isStateSyncronized } from '@dcl/sdk/network'
import { isInsideQuestZone } from './questZone'
import { getRoundState } from './networkRoundState'
import { startPlayerSessionSync, setJoined, getOwnSession, getJoinedUserIds } from './networkPlayerSession'

/** Zone membership is checked far more often than the 1s round tick, but still cheap and bounded. */
const ZONE_CHECK_INTERVAL_MS = 300
/** Consecutive outside-zone checks required before actually un-joining - absorbs boundary jitter. */
const LEAVE_CONFIRM_TICKS = 2
/** Consecutive synced ticks required before JOIN is offered (~3s at this interval) - the safety barrier from the earlier bootstrap investigation. */
const SETTLE_TICKS = 10

export interface SessionSnapshot {
    inZone: boolean
    isSafeToJoin: boolean
    joined: boolean
    /** Total currently-joined players - used for the pre-join "N PLAYERS ACTIVE" display. */
    joinedPlayerCount: number
}

/**
 * Owns physical Quest Zone membership (local-only - nobody else needs to know you're
 * merely standing in the circle) and orchestrates this client's own join/leave writes
 * to the synced PlayerSession. Runs its own faster interval, independent of
 * RoundManager's 1s round tick, since position polling is a different concern with a
 * different responsiveness target.
 */
class PlayerSessionManager {
    private intervalId: number | null = null
    private inZone = false
    private outsideStreak = 0
    private settledTicks = 0

    start(): void {
        if (this.intervalId !== null) return
        startPlayerSessionSync()
        this.intervalId = setInterval(() => this.tick(), ZONE_CHECK_INTERVAL_MS)
    }

    getSnapshot(): SessionSnapshot {
        const session = getOwnSession()
        return {
            inZone: this.inZone,
            isSafeToJoin: isStateSyncronized() && this.settledTicks >= SETTLE_TICKS,
            joined: session?.joined ?? false,
            joinedPlayerCount: getJoinedUserIds().length
        }
    }

    /** Called by the UI when the player presses JOIN. */
    joinSocialQuest(): void {
        if (!isStateSyncronized() || this.settledTicks < SETTLE_TICKS || !this.inZone) return
        const state = getRoundState()
        setJoined(true, state.roundId + 1)
    }

    private tick(): void {
        this.settledTicks = isStateSyncronized() ? this.settledTicks + 1 : 0

        const position = Transform.getOrNull(engine.PlayerEntity)?.position
        const currentlyInside = position !== null && position !== undefined && isInsideQuestZone(position.x, position.z)
        this.inZone = currentlyInside

        if (currentlyInside) {
            this.outsideStreak = 0
            return
        }

        this.outsideStreak += 1
        if (this.outsideStreak < LEAVE_CONFIRM_TICKS) return
        if (!isStateSyncronized()) return

        const session = getOwnSession()
        if (session?.joined) {
            setJoined(false)
        }
    }
}

/** Single instance for the whole session - the zone-check loop never restarts due to UI re-renders. */
export const playerSessionManager = new PlayerSessionManager()
