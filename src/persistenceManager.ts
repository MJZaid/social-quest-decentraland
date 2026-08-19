import { getPlayer } from '@dcl/sdk/players'
import { Storage } from '@dcl/sdk/server'
import { persistenceRoom } from './persistenceMessages'
import { getRoundState, startRoundStateSync, SharedPhase, RoundStateValue } from './networkRoundState'
import { getAnswersForRound, AnswerOption } from './networkPlayerAnswer'
import { getActiveUserIds } from './networkPlayerSession'
import { hydrateConnections } from './connectionsManager'
import { acknowledgeLevelWithoutCelebration } from './friendshipManager'
import {
    PersistedSocialQuestProfileV1,
    STORAGE_KEY,
    emptyProfile,
    sanitizeProfile,
    normalizeUserId,
    hasProcessedEventId,
    pushProcessedEventId
} from './persistenceSchema'

// -----------------------------------------------------------------------
// PERSISTENCE v1 - side channel only.
//
// Round completion and validity are determined entirely server-side, by
// reading the SAME synced RoundState/PlayerAnswer/PlayerSession the client
// already relies on for gameplay (networkRoundState.ts, networkPlayerAnswer.ts,
// networkPlayerSession.ts - all read-only here, none of it modified). The
// client never reports round outcomes and is never trusted for them - it only
// ever asks for its own persisted profile on join.
//
// Nothing in this file blocks, delays, or changes the outcome of gameplay. If
// Storage.player fails for any reason, the failure is logged and nothing else
// happens - the client's own local Connections/Friendship state (which drives
// every visible gameplay behavior) is completely independent of whether this
// server-side round-trip ever succeeds.
// -----------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SERVER SIDE
// ---------------------------------------------------------------------------

/**
 * Unique per boot of the authoritative server - generated once, here, from the
 * server's own clock and a random suffix. Never derived from anything a client
 * sends. Combined with a roundId AND a sorted partner pair (see sortedPairKey)
 * to build a globally-unique dedup key, so a restarted server that reissues
 * roundId 1 can never collide with a previous session's roundId 1, and a
 * round with several partners never lets a late-arriving pair's answer
 * overwrite or be blocked by an earlier pair's already-applied delta.
 */
const SERVER_SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/**
 * In-memory authoritative copy per player, for the lifetime of this server
 * process. This - not Storage.player itself - is what prevents a read-modify-write
 * race between two events for the same player: each event mutates this
 * in-memory object synchronously (JS has no thread interleaving) before the
 * resulting write is queued, so two overlapping saves can never each compute
 * their delta from the same stale snapshot. Storage.player.set() additionally
 * serializes and coalesces concurrent writes to the same key on its own, so the
 * two layers together fully rule out an old write clobbering a newer one.
 */
const serverProfiles = new Map<string, PersistedSocialQuestProfileV1>()
/** Addresses currently mid-load, so a second caller arriving before the first Storage.player.get() resolves doesn't race it - both await the same promise. */
const loadingInFlight = new Map<string, Promise<PersistedSocialQuestProfileV1>>()
/** Fast-path, in-memory-only record of round-pair events already handled THIS server process - avoids redundant work when the same pair is re-scanned on later RESULT ticks. Not the source of truth: each player's own persisted recentProcessedEventIds is, and is checked independently before every write, so this Set being empty on a fresh server boot is always safe. */
const processedPairEventsInMemory = new Set<string>()

async function loadProfile(address: string): Promise<PersistedSocialQuestProfileV1> {
    const existing = serverProfiles.get(address)
    if (existing) return existing

    const inFlight = loadingInFlight.get(address)
    if (inFlight) return inFlight

    const promise = (async () => {
        try {
            const raw = await Storage.player.get<unknown>(address, STORAGE_KEY, { fresh: true })
            const profile = raw === null ? emptyProfile() : sanitizeProfile(raw)
            serverProfiles.set(address, profile)
            return profile
        } catch (err) {
            console.error(
                `[Persistence][SERVER] Storage.player.get failed - continuing with an empty profile, session-only for this player: ${
                    err instanceof Error ? err.message : String(err)
                }`
            )
            const profile = emptyProfile()
            serverProfiles.set(address, profile)
            return profile
        } finally {
            loadingInFlight.delete(address)
        }
    })()

    loadingInFlight.set(address, promise)
    return promise
}

async function saveProfile(address: string, profile: PersistedSocialQuestProfileV1): Promise<boolean> {
    try {
        const ok = await Storage.player.set(address, STORAGE_KEY, profile)
        if (!ok) {
            console.error('[Persistence][SERVER] Storage.player.set returned false - this round was not persisted, but gameplay is unaffected')
        }
        return ok
    } catch (err) {
        console.error(
            `[Persistence][SERVER] Storage.player.set threw - this round was not persisted, but gameplay is unaffected: ${
                err instanceof Error ? err.message : String(err)
            }`
        )
        return false
    }
}

/** Order-independent pair key so `roundId:A,B` and `roundId:B,A` are always the same event. */
function sortedPairKey(a: string, b: string): string {
    return [a, b].sort().join(',')
}

/** Applies one round's delta to a single player's own profile against `otherUserId`, durably deduped via that player's own persisted recentProcessedEventIds - independent of the in-memory fast path, so this stays correct even across a server restart. */
async function applyDeltaToPlayer(address: string, otherUserId: string, same: boolean, eventId: string): Promise<void> {
    const profile = await loadProfile(address)
    if (hasProcessedEventId(profile, eventId)) return // already applied - durable, cross-restart dedup

    const record = profile.connections[otherUserId] ?? { roundsTogether: 0, sameAnswers: 0, differentAnswers: 0 }
    record.roundsTogether += 1
    if (same) {
        record.sameAnswers += 1
    } else {
        record.differentAnswers += 1
    }
    profile.connections[otherUserId] = record
    pushProcessedEventId(profile, eventId)

    await saveProfile(address, profile)
}

/** Persists one validated pair's outcome for BOTH players symmetrically - each player's own profile gets a delta against the other, under the exact same eventId, so the pair as a whole is one atomic unit of dedup even though it lives in two separate Storage.player records. */
async function processRoundPair(roundId: number, userA: string, userB: string, same: boolean): Promise<void> {
    const eventId = `${SERVER_SESSION_ID}:${roundId}:${sortedPairKey(userA, userB)}`
    if (processedPairEventsInMemory.has(eventId)) return
    processedPairEventsInMemory.add(eventId)

    try {
        await Promise.all([applyDeltaToPlayer(userA, userB, same, eventId), applyDeltaToPlayer(userB, userA, same, eventId)])
    } catch (err) {
        console.error(`[Persistence][SERVER] Failed to process round ${roundId} pair: ${err instanceof Error ? err.message : String(err)}`)
    }
}

/**
 * Scans the CURRENT round's live synced answers (read-only - never writes to
 * RoundState/PlayerAnswer/PlayerSession) and persists every VALID pair not yet
 * seen this round: both users must be in getActiveUserIds(roundId) (eligible,
 * joined participants for this specific round - excludes spectators and
 * players pending for a future round) AND have an answer that isn't
 * AnswerOption.NO_ANSWER. same/different is computed here, from the real
 * synced answers, never accepted from a client claim.
 *
 * Runs every server tick while phase is RESULT (same 1s cadence as the
 * client's own round loop), mirroring why connectionsManager.processRoundState()
 * itself re-scans every RESULT tick: answers can arrive late. A pair already
 * recorded this round (processedPairEventsInMemory) is a cheap no-op on every
 * subsequent tick, so this never turns into a write-every-tick problem - each
 * pair is written at most once, the moment both its answers become valid,
 * which is also why the "last round before leaving" problem doesn't apply
 * here: persistence happens live, during RESULT, not after the next round starts.
 */
function scanCurrentRoundForValidPairs(state: RoundStateValue): void {
    if (state.phase !== SharedPhase.RESULT) return

    const eligible = new Set(getActiveUserIds(state.roundId))
    const answers = getAnswersForRound(state.roundId).filter((answer) => answer.option !== AnswerOption.NO_ANSWER && eligible.has(answer.userId))

    for (let i = 0; i < answers.length; i++) {
        for (let j = i + 1; j < answers.length; j++) {
            const a = answers[i]
            const b = answers[j]
            void processRoundPair(state.roundId, normalizeUserId(a.userId), normalizeUserId(b.userId), a.option === b.option)
        }
    }
}

let serverTickIntervalId: number | null = null

export function initPersistenceServer(): void {
    // Attaches this server's local RoundState reference to the same fixed
    // network entity clients use, so getRoundState() below reads the real
    // synced value instead of the untouched INITIAL_STATE default - the exact
    // same call a late-joining client already makes today. Read-only in
    // practice: this server never calls writeRoundState().
    startRoundStateSync()

    persistenceRoom.onMessage('requestProfile', async (_data, context) => {
        if (!context) {
            console.log('[Persistence][SERVER] requestProfile received with no context - dropping')
            return
        }
        const address = normalizeUserId(context.from)
        try {
            const profile = await loadProfile(address)
            persistenceRoom.send('profileResponse', { found: true, dataJson: JSON.stringify(profile), error: '' }, { to: [context.from] })
        } catch (err) {
            console.error(`[Persistence][SERVER] requestProfile handling failed: ${err instanceof Error ? err.message : String(err)}`)
            persistenceRoom.send('profileResponse', { found: false, dataJson: '', error: 'load_failed' }, { to: [context.from] })
        }
    })

    if (serverTickIntervalId === null) {
        serverTickIntervalId = setInterval(() => scanCurrentRoundForValidPairs(getRoundState()), 1000)
    }
}

// ---------------------------------------------------------------------------
// CLIENT SIDE
// ---------------------------------------------------------------------------

let requestedProfile = false
let hasHydrated = false

/** Product decision (carried over from the persistence research phase): only players with a stable, persistent identity participate. Guests stay fully session-only, exactly like today - never blocked from playing. */
function isPersistenceEligible(): boolean {
    const player = getPlayer()
    if (!player) return false
    if (player.isGuest) return false
    return true
}

export function initPersistenceClient(): void {
    persistenceRoom.onMessage('profileResponse', (data) => {
        if (hasHydrated) return // idempotent - never apply a persisted baseline twice, however this message arrives
        if (!data.found) return
        hasHydrated = true
        try {
            const profile = sanitizeProfile(JSON.parse(data.dataJson))
            const records = Object.entries(profile.connections).map(([otherUserId, record]) => ({
                otherUserId,
                roundsTogether: record.roundsTogether,
                sameAnswers: record.sameAnswers,
                differentAnswers: record.differentAnswers
            }))
            const results = hydrateConnections(records)
            for (const result of results) {
                // Only the merge case needs reconciling - see hydrateConnections()'s
                // own doc comment and acknowledgeLevelWithoutCelebration()'s.
                if (result.wasMerge) {
                    acknowledgeLevelWithoutCelebration(result.otherUserId, result.roundsTogether)
                }
            }
            console.log(`[Persistence][CLIENT] Loaded ${records.length} persisted connection(s)`)
        } catch (err) {
            console.error(`[Persistence][CLIENT] Failed to parse loaded profile - continuing session-only: ${err instanceof Error ? err.message : String(err)}`)
        }
    })
}

/**
 * Called once per tick from roundManager.tick(), same cadence as every other
 * tick*() call already there. Requests the persisted profile exactly once, the
 * moment identity is available and the player isn't a guest - deliberately not
 * gated on having pressed JOIN, so hydration is requested well before the first
 * round could complete (though see hydrateConnections()'s merge handling for
 * what happens if a round finishes locally before the response arrives
 * anyway). Never blocks or gates anything: if this never fires (identity never
 * resolves, message never arrives), the game simply continues session-only,
 * exactly like it does today.
 */
export function tickPersistenceLoad(): void {
    if (requestedProfile) return
    if (!isPersistenceEligible()) return
    requestedProfile = true
    persistenceRoom.send('requestProfile', {})
}
