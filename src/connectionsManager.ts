import { myProfile } from '@dcl/sdk/network'
import { getPlayer } from '@dcl/sdk/players'
import { SharedPhase, RoundStateValue } from './networkRoundState'
import { AnswerOption, getAnswersForRound, getDisplayName } from './networkPlayerAnswer'

/** Recent Connections history is capped, not a full session log. */
const MAX_RECENT_CONNECTIONS = 5

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

/** Presentation-only history of newly-created Connections, newest first, capped - separate from the relationship counters. */
let recentConnectionUserIds: string[] = []
/** Presentation-only cache: userId -> best-resolved display name, populated while that player is provably present. */
const displayNameCache = new Map<string, string>()

/** otherUserId + same/different outcome for every partner actually incremented (not just re-scanned) during the round currentRoundId currently reflects - same reset lifetime as newConnectionsThisRound. Used only by the persistence layer (persistenceManager.ts) to report deltas exactly once per round; gameplay/celebrations never read this. */
export interface ProcessedRoundPair {
    otherUserId: string
    same: boolean
}
let processedThisRound: ProcessedRoundPair[] = []

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
        processedThisRound = []
    }

    const answers = getAnswersForRound(state.roundId)
    const myAnswer = answers.find((answer) => answer.userId === myProfile.userId && answer.option !== AnswerOption.NO_ANSWER)
    if (!myAnswer) return // I didn't answer this round - nothing to process

    for (const other of answers) {
        if (other.userId === myProfile.userId) continue
        if (other.option === AnswerOption.NO_ANSWER) continue

        const { isNew, applied } = recordRound(other.userId, state.roundId, myAnswer.option, other.option)
        if (isNew) {
            newConnectionsThisRound.push(other.userId)
            addToRecentConnections(other.userId)
        }
        if (applied) {
            processedThisRound.push({ otherUserId: other.userId, same: myAnswer.option === other.option })
        }
        // Attempted for every encounter (not just isNew) so a name that failed to resolve on
        // the very first round together can still be picked up on a later one - cheap no-op
        // once cached.
        cacheDisplayNameIfNeeded(other.userId)
    }
}

/** Records `userId` as the newest Connection, capped at MAX_RECENT_CONNECTIONS. Only ever called for a genuinely new relationship - repeated rounds with an existing partner never re-add or reorder them. */
function addToRecentConnections(userId: string): void {
    recentConnectionUserIds = [userId, ...recentConnectionUserIds].slice(0, MAX_RECENT_CONNECTIONS)
}

/**
 * Caches the best available display name the moment it can be resolved. Uses getPlayer()
 * directly (not getDisplayName()'s own 'Player' fallback string) to detect genuine
 * resolvability, so we never mistake "could not resolve" for a real name - an unresolved
 * entry is simply left out of the cache and the UI applies its own Questmate/Questmate N
 * fallback instead. The cached value itself still comes from getDisplayName(), reusing the
 * project's existing safe resolution.
 */
function cacheDisplayNameIfNeeded(userId: string): void {
    if (displayNameCache.has(userId)) return
    if (!getPlayer({ userId })) return // not resolvable right now - try again next encounter
    displayNameCache.set(userId, getDisplayName(userId))
}

/**
 * Increments the relationship with `otherUserId` for `roundId` exactly once, no matter
 * how many times this round gets rescanned as late answers arrive. Bounded bookkeeping:
 * one lastProcessedRoundId per unique partner, not one marker per round ever played.
 * Returns true only the first time this partner is ever recorded (a brand new Connection).
 */
function recordRound(
    otherUserId: string,
    roundId: number,
    myOption: AnswerOption,
    otherOption: AnswerOption
): { isNew: boolean; applied: boolean } {
    const existing = connections.get(otherUserId)
    if (existing && existing.lastProcessedRoundId === roundId) return { isNew: false, applied: false } // already counted this round for this partner

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
    return { isNew, applied: true }
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

/** Newest-first userIds of the most recently created Connections this session, capped at MAX_RECENT_CONNECTIONS (or `limit` if smaller). */
export function getRecentConnections(limit: number = MAX_RECENT_CONNECTIONS): string[] {
    return recentConnectionUserIds.slice(0, limit)
}

/** The cached display name for `userId`, or null if it was never resolvable while that player was present. Presentation only - never the identity key. */
export function getDisplayNameFor(userId: string): string | null {
    return displayNameCache.get(userId) ?? null
}

/**
 * Seeds `connections` from a previously-persisted profile (persistenceManager.ts),
 * called once at startup before any round is processed this session. Never
 * overwrites an entry that already exists (defensive - in the normal case
 * `connections` is empty when this runs, since hydration completes before the
 * player has played any round this session).
 *
 * lastProcessedRoundId is set to -1 (the same sentinel a brand-new live
 * connection starts with), never to a value from a previous session - a
 * previous session's roundId has no relationship to this session's roundId
 * numbering, so reusing it could wrongly suppress (or double-count) this
 * session's very first real round with that partner. This is also exactly why
 * `newConnectionsThisRound`/celebrations are never triggered by hydration: it
 * only ever calls connections.set() directly, never recordRound() - the
 * NEW_CONNECTION celebration path is untouched, and friendshipManager's own
 * "first observation this session" rule (see friendshipManager.ts) naturally
 * suppresses a false level-up celebration the first time it evaluates a
 * hydrated partner's already-high roundsTogether.
 */
export function hydrateConnections(records: ConnectionRecord[]): void {
    for (const record of records) {
        if (connections.has(record.otherUserId)) continue
        connections.set(record.otherUserId, {
            otherUserId: record.otherUserId,
            roundsTogether: record.roundsTogether,
            sameAnswers: record.sameAnswers,
            differentAnswers: record.differentAnswers,
            lastProcessedRoundId: -1
        })
    }
}

/**
 * The partners actually incremented (not just re-scanned) during the round
 * `currentRoundId` currently reflects, plus that roundId itself so a caller can
 * verify it's reading the round it expects. Used only by persistenceManager.ts
 * to report deltas to the authoritative server exactly once per round - see
 * processRoundState()'s reset timing for why this stays valid through the
 * following WAITING/ANSWERING window, not just during RESULT itself.
 */
export function getProcessedThisRound(): { roundId: number; entries: ProcessedRoundPair[] } | null {
    if (currentRoundId === null) return null
    return { roundId: currentRoundId, entries: [...processedThisRound] }
}
