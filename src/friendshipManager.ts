import { getAllConnections } from './connectionsManager'

export type FriendshipLevel =
    | 'NEW CONNECTION'
    | 'SPARK'
    | 'FAMILIAR FACE'
    | 'FRIENDS'
    | 'CLOSE FRIENDS'
    | 'COSMIC BOND'
    | 'FRIENDS FOREVER'

export interface FriendshipLevelUpEvent {
    otherUserId: string
    previousLevel: FriendshipLevel
    newLevel: FriendshipLevel
    roundsTogether: number
}

interface FriendshipLevelDefinition {
    /** Ordering key - level-up detection compares this, never the display string. */
    rank: number
    minRounds: number
    level: FriendshipLevel
}

/** Ascending by minRounds/rank. CONSTELLATION is deliberately absent - reserved for a future global unique-connections system. */
const FRIENDSHIP_LEVELS: FriendshipLevelDefinition[] = [
    { rank: 0, minRounds: 1, level: 'NEW CONNECTION' },
    { rank: 1, minRounds: 20, level: 'SPARK' },
    { rank: 2, minRounds: 50, level: 'FAMILIAR FACE' },
    { rank: 3, minRounds: 100, level: 'FRIENDS' },
    { rank: 4, minRounds: 200, level: 'CLOSE FRIENDS' },
    { rank: 5, minRounds: 500, level: 'COSMIC BOND' },
    { rank: 6, minRounds: 1000, level: 'FRIENDS FOREVER' }
]

function getLevelDefinition(roundsTogether: number): FriendshipLevelDefinition | null {
    let match: FriendshipLevelDefinition | null = null
    for (const definition of FRIENDSHIP_LEVELS) {
        if (roundsTogether >= definition.minRounds) match = definition
    }
    return match
}

/** Pure lookup: the highest Friendship level whose threshold `roundsTogether` has reached, or null below the first threshold. */
export function getFriendshipLevel(roundsTogether: number): FriendshipLevel | null {
    return getLevelDefinition(roundsTogether)?.level ?? null
}

/**
 * Last level acknowledged for each partner - the baseline a level-up is measured
 * against. Session-only, local to this client, never synced: roundsTogether (the
 * single source of truth) already lives in connectionsManager, this only remembers
 * "how far this client has already seen/reported" for that derived value.
 */
const acknowledgedLevels = new Map<string, FriendshipLevelDefinition>()

let lastTickEvents: FriendshipLevelUpEvent[] = []

/**
 * Re-derives every partner's Friendship level from connectionsManager's live
 * roundsTogether and reports genuine level-ups only. Must run after
 * connectionsManager's processRoundState() in the same tick so it always reads
 * post-increment values (including late RESULT-tick answers Connections just
 * re-scanned) - see roundManager.tick() wiring.
 *
 * First-observation rule: a partner seen for the first time has its current level
 * recorded as the baseline with NO event emitted. Otherwise the very first shared
 * round would always "level up" to NEW CONNECTION, duplicating the event the
 * existing NEW CONNECTION celebration already owns. The first real Friendship
 * event is therefore NEW CONNECTION -> SPARK at roundsTogether === 20.
 *
 * Because roundsTogether only ever increases (connectionsManager never decrements
 * it) and rank is derived from it monotonically, "rank increased since last
 * acknowledged" is a naturally exactly-once signal: the acknowledged rank is
 * updated immediately on detection, so no later tick can re-report the same
 * crossing.
 */
export function evaluateFriendshipLevels(): void {
    const events: FriendshipLevelUpEvent[] = []

    for (const connection of getAllConnections()) {
        const currentDefinition = getLevelDefinition(connection.roundsTogether)
        if (currentDefinition === null) continue // not reachable in practice (a Connection implies roundsTogether >= 1), kept for correctness of the pure lookup

        const acknowledged = acknowledgedLevels.get(connection.otherUserId)
        if (acknowledged === undefined) {
            acknowledgedLevels.set(connection.otherUserId, currentDefinition)
            continue
        }

        if (currentDefinition.rank > acknowledged.rank) {
            events.push({
                otherUserId: connection.otherUserId,
                previousLevel: acknowledged.level,
                newLevel: currentDefinition.level,
                roundsTogether: connection.roundsTogether
            })
            acknowledgedLevels.set(connection.otherUserId, currentDefinition)
        }
    }

    lastTickEvents = events
}

/** Genuine level-up events detected on the most recent evaluateFriendshipLevels() call - empty on every tick without a crossing. No display names resolved here; identity stays userId. */
export function getFriendshipLevelUpsFromLastTick(): FriendshipLevelUpEvent[] {
    return [...lastTickEvents]
}

/**
 * Sets the acknowledged baseline for a partner directly, without emitting a
 * level-up event. Used only by persistenceManager.ts, only for the "merge"
 * case of connectionsManager.hydrateConnections() - when persisted rounds are
 * added on top of a connection this session had already locally recorded
 * (and therefore already acknowledged at its pre-hydration level). Without
 * this, the jump from e.g. 1 to 54 roundsTogether would look like a genuine
 * level-up the next evaluateFriendshipLevels() tick, when it's really just
 * hydration catching up. Never called for a brand-new hydration - that case
 * is already correctly silent via the "first observation" rule above.
 */
export function acknowledgeLevelWithoutCelebration(otherUserId: string, roundsTogether: number): void {
    const definition = getLevelDefinition(roundsTogether)
    if (definition === null) return
    acknowledgedLevels.set(otherUserId, definition)
}
