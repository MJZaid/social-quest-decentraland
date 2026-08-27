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
    /**
     * Best display name the AUTHORITATIVE SERVER has persisted for this
     * partner (see persistenceManager.ts/hydrateConnections below) - distinct
     * from, and lower-priority than, this client's own live displayNameCache:
     * a currently-observable name (getDisplayNameFor) always wins over this
     * potentially-older persisted one in the UI. Only ever set via hydration;
     * live gameplay (recordRound) never touches it.
     */
    lastKnownDisplayName?: string
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
        if (isNew) {
            newConnectionsThisRound.push(other.userId)
            addToRecentConnections(other.userId)
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
    return {
        otherUserId: record.otherUserId,
        roundsTogether: record.roundsTogether,
        sameAnswers: record.sameAnswers,
        differentAnswers: record.differentAnswers,
        lastKnownDisplayName: record.lastKnownDisplayName
    }
}

export function getAllConnections(): ConnectionRecord[] {
    return Array.from(connections.values()).map((record) => ({
        otherUserId: record.otherUserId,
        roundsTogether: record.roundsTogether,
        sameAnswers: record.sameAnswers,
        differentAnswers: record.differentAnswers,
        lastKnownDisplayName: record.lastKnownDisplayName
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

/** Result of hydrating one partner - see hydrateConnections() below. */
export interface HydrationResult {
    otherUserId: string
    /** The resulting total after hydration (merged, if wasMerge). */
    roundsTogether: number
    /** True if a local entry already existed for this partner (rounds played this session, before LOAD resolved) and was merged with the persisted baseline, rather than being a fresh first-time hydration. */
    wasMerge: boolean
}

/**
 * Seeds `connections` from a previously-persisted profile (persistenceManager.ts),
 * called once at startup before any round is processed this session, but LOAD is
 * async and gameplay is never blocked on it - so a round can genuinely complete
 * locally with a partner BEFORE this runs for that same partner.
 *
 * Three cases, handled differently:
 *
 * - No local entry yet (the common case): seed fresh from the persisted values,
 *   with lastProcessedRoundId = -1 (the same sentinel a brand-new live connection
 *   starts with) - never a roundId from a previous session, since that numbering
 *   has no relationship to this session's and could wrongly suppress or
 *   double-count this session's first real round with that partner.
 *
 * - A local entry already exists AND `replaceInstead` says the persisted
 *   snapshot already reflects it: the server's own independent round-detection
 *   (see persistenceManager.ts) can persist a round before this client's own
 *   LOAD response arrives for it - in that case the persisted total already
 *   IS local+persisted, and adding again would double-count. The caller is
 *   responsible for that determination (it requires knowing the server's
 *   session id and event log, which are persistence-layer concerns this
 *   module has no reason to know about); this function just trusts the flag.
 *
 * - A local entry already exists and `replaceInstead` does NOT cover it: the
 *   persisted counts are ADDED on top of the local ones, never overwritten and
 *   never dropped - overwriting would silently lose this session's
 *   already-celebrated progress; dropping the persisted data (an earlier bug)
 *   would silently lose the player's entire history instead. lastProcessedRoundId
 *   is left untouched in both existing-entry cases, preserving this session's
 *   own round-dedup state.
 *
 * Never triggers the NEW_CONNECTION celebration (only ever calls connections.set()
 * directly, never recordRound()). The fresh-hydration case never triggers a false
 * Friendship celebration either, via friendshipManager's own "first observation
 * this session" rule. The other two cases can still involve a jump in
 * roundsTogether that isn't a genuine level-up - see wasMerge in the returned
 * result, and friendshipManager.acknowledgeLevelWithoutCelebration, which the
 * caller uses to reconcile the baseline for exactly that.
 */
export function hydrateConnections(records: ConnectionRecord[], replaceInstead: ReadonlySet<string> = new Set()): HydrationResult[] {
    const results: HydrationResult[] = []
    for (const record of records) {
        const existing = connections.get(record.otherUserId)
        if (existing) {
            if (replaceInstead.has(record.otherUserId)) {
                existing.roundsTogether = record.roundsTogether
                existing.sameAnswers = record.sameAnswers
                existing.differentAnswers = record.differentAnswers
            } else {
                existing.roundsTogether += record.roundsTogether
                existing.sameAnswers += record.sameAnswers
                existing.differentAnswers += record.differentAnswers
            }
            // Name hydration is independent of the counter reconciliation above (replace
            // vs add) - either way, a persisted name simply wins if present, otherwise
            // whatever this session already had (almost always nothing yet) is kept.
            // Never triggers a celebration or touches Friendship - purely a name field.
            existing.lastKnownDisplayName = record.lastKnownDisplayName ?? existing.lastKnownDisplayName
            results.push({ otherUserId: record.otherUserId, roundsTogether: existing.roundsTogether, wasMerge: true })
        } else {
            connections.set(record.otherUserId, {
                otherUserId: record.otherUserId,
                roundsTogether: record.roundsTogether,
                sameAnswers: record.sameAnswers,
                differentAnswers: record.differentAnswers,
                lastKnownDisplayName: record.lastKnownDisplayName,
                lastProcessedRoundId: -1
            })
            results.push({ otherUserId: record.otherUserId, roundsTogether: record.roundsTogether, wasMerge: false })
        }
    }
    return results
}

