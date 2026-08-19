import { getPlayer } from '@dcl/sdk/players'
import { Storage } from '@dcl/sdk/server'
import { persistenceRoom } from './persistenceMessages'
import { RoundStateValue } from './networkRoundState'
import { getProcessedThisRound, hydrateConnections } from './connectionsManager'
import {
    PersistedConnectionDelta,
    PersistedSocialQuestProfileV1,
    STORAGE_KEY,
    MAX_DELTAS_PER_ROUND,
    emptyProfile,
    sanitizeProfile,
    normalizeUserId,
    hasProcessedEventId,
    pushProcessedEventId
} from './persistenceSchema'

// -----------------------------------------------------------------------
// PERSISTENCE v1 - side channel only.
//
// Nothing in this file is allowed to block, delay, or change the outcome of
// gameplay. Every entry point here is either: (a) called from the existing
// roundManager tick loop as one more no-op-if-not-ready check, exactly like
// the existing celebration ticks, or (b) a server-side message handler that
// only ever writes to Storage.player for the authenticated sender
// (context.from) and never touches round/session/answer state.
//
// If Storage.player fails for any reason, the failure is logged and nothing
// else happens - the client's own local Connections/Friendship state (which
// drives every visible gameplay behavior) is completely independent of
// whether this round-trip ever succeeds.
// -----------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SERVER SIDE
// ---------------------------------------------------------------------------

/**
 * Unique per boot of the authoritative server - generated once, here, from the
 * server's own clock and a random suffix. Never derived from anything a client
 * sends. Combined with a client-reported roundId to build a globally-unique
 * dedup key (see reportRound handler below), so a restarted server that
 * reissues roundId 1 can never collide with a previous session's roundId 1.
 */
const SERVER_SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/**
 * In-memory authoritative copy per player, for the lifetime of this server
 * process. This - not Storage.player itself - is what prevents a read-modify-write
 * race between two rapid events for the same player: each event mutates this
 * in-memory object synchronously (JS has no thread interleaving) before the
 * resulting write is queued, so two overlapping saves can never each compute
 * their delta from the same stale snapshot. Storage.player.set() additionally
 * serializes and coalesces concurrent writes to the same key on its own, so the
 * two layers together fully rule out an old write clobbering a newer one.
 */
const serverProfiles = new Map<string, PersistedSocialQuestProfileV1>()
/** Addresses currently mid-load, so a second requestProfile arriving before the first Storage.player.get() resolves doesn't race it. */
const loadingInFlight = new Map<string, Promise<PersistedSocialQuestProfileV1>>()

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

/** Parses and validates the client-reported per-round deltas. Never trusts a raw counter from the client - only ever +1-worth-of-information entries, capped defensively, each independently validated. */
function parseDeltas(deltasJson: string): PersistedConnectionDelta[] {
    try {
        const parsed: unknown = JSON.parse(deltasJson)
        if (!Array.isArray(parsed)) return []
        const result: PersistedConnectionDelta[] = []
        for (const item of parsed) {
            if (result.length >= MAX_DELTAS_PER_ROUND) break
            if (!item || typeof item !== 'object') continue
            const otherUserId = (item as Record<string, unknown>).otherUserId
            const same = (item as Record<string, unknown>).same
            if (typeof otherUserId !== 'string' || otherUserId.length === 0) continue
            if (typeof same !== 'boolean') continue
            result.push({ otherUserId: normalizeUserId(otherUserId), same })
        }
        return result
    } catch {
        return []
    }
}

export function initPersistenceServer(): void {
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

    persistenceRoom.onMessage('reportRound', async (data, context) => {
        if (!context) {
            console.log('[Persistence][SERVER] reportRound received with no context - dropping')
            return
        }
        const address = normalizeUserId(context.from)

        try {
            const profile = await loadProfile(address)

            // roundId only identifies WHICH round, for dedup purposes - it is not
            // trusted as proof anything happened. Global uniqueness across server
            // restarts comes entirely from SERVER_SESSION_ID above, which no client
            // ever sees or influences.
            const roundEventId = `${SERVER_SESSION_ID}:${data.roundId}`

            if (hasProcessedEventId(profile, roundEventId)) {
                // Duplicate report (reconnect, retry, late duplicate message) - no-op,
                // but still ack ok so the client has no reason to keep retrying.
                persistenceRoom.send('reportRoundAck', { ok: true, error: '' }, { to: [context.from] })
                return
            }

            const deltas = parseDeltas(data.deltasJson)
            for (const delta of deltas) {
                const record = profile.connections[delta.otherUserId] ?? { roundsTogether: 0, sameAnswers: 0, differentAnswers: 0 }
                record.roundsTogether += 1
                if (delta.same) {
                    record.sameAnswers += 1
                } else {
                    record.differentAnswers += 1
                }
                profile.connections[delta.otherUserId] = record
            }
            pushProcessedEventId(profile, roundEventId)

            const ok = await saveProfile(address, profile)
            persistenceRoom.send('reportRoundAck', { ok, error: ok ? '' : 'save_failed' }, { to: [context.from] })
        } catch (err) {
            console.error(`[Persistence][SERVER] reportRound handling failed: ${err instanceof Error ? err.message : String(err)}`)
            persistenceRoom.send('reportRoundAck', { ok: false, error: 'handler_error' }, { to: [context.from] })
        }
    })
}

// ---------------------------------------------------------------------------
// CLIENT SIDE
// ---------------------------------------------------------------------------

let requestedProfile = false
let lastSeenRoundId: number | null = null

/** Product decision (carried over from the persistence research phase): only players with a stable, persistent identity participate. Guests stay fully session-only, exactly like today - never blocked from playing. */
function isPersistenceEligible(): boolean {
    const player = getPlayer()
    if (!player) return false
    if (player.isGuest) return false
    return true
}

export function initPersistenceClient(): void {
    persistenceRoom.onMessage('profileResponse', (data) => {
        if (!data.found) return
        try {
            const profile = sanitizeProfile(JSON.parse(data.dataJson))
            const records = Object.entries(profile.connections).map(([otherUserId, record]) => ({
                otherUserId,
                roundsTogether: record.roundsTogether,
                sameAnswers: record.sameAnswers,
                differentAnswers: record.differentAnswers
            }))
            hydrateConnections(records)
            console.log(`[Persistence][CLIENT] Loaded ${records.length} persisted connection(s)`)
        } catch (err) {
            console.error(`[Persistence][CLIENT] Failed to parse loaded profile - continuing session-only: ${err instanceof Error ? err.message : String(err)}`)
        }
    })

    persistenceRoom.onMessage('reportRoundAck', (data) => {
        if (!data.ok) {
            console.error(`[Persistence][CLIENT] Server failed to persist a round (${data.error}) - this session's progress is unaffected, only long-term persistence for that round may be lost`)
        }
    })
}

/**
 * Called once per tick from roundManager.tick(), same cadence as every other
 * tick*() call already there. Requests the persisted profile exactly once, the
 * moment identity is available and the player isn't a guest - deliberately not
 * gated on having pressed JOIN, so hydration is done well before the first
 * round could complete. Never blocks or gates anything: if this never fires
 * (identity never resolves, message never arrives), the game simply continues
 * session-only, exactly like it does today.
 */
export function tickPersistenceLoad(): void {
    if (requestedProfile) return
    if (!isPersistenceEligible()) return
    requestedProfile = true
    persistenceRoom.send('requestProfile', {})
}

/**
 * Called once per tick from roundManager.tick(), after connectionsManager's own
 * processRoundState() has run for this tick. Reports the previous round's
 * connection deltas exactly once, the instant a new roundId is observed - see
 * connectionsManager.getProcessedThisRound() for why that data is still valid
 * at this point (it isn't reset until connectionsManager itself next sees a
 * RESULT tick, which only happens once the new round reaches RESULT).
 *
 * Known limitation: if a session ends (player leaves/disconnects) without ever
 * observing another round start, that last round's deltas are never reported -
 * there is no reliable "about to disconnect" hook to flush them. Documented,
 * not solved, in this v1: the data isn't lost from that session's own gameplay
 * (celebrations/Friendship already reflected it locally), only from what gets
 * persisted for next time.
 */
export function tickPersistenceSave(state: RoundStateValue): void {
    if (!isPersistenceEligible()) return
    if (state.roundId === lastSeenRoundId) return

    const previousRoundId = lastSeenRoundId
    lastSeenRoundId = state.roundId
    if (previousRoundId === null) return // first observation this session - nothing finished yet to report

    const processed = getProcessedThisRound()
    if (processed === null || processed.roundId !== previousRoundId) return // defensive - see getProcessedThisRound()'s own contract
    if (processed.entries.length === 0) return // no partners recorded this round (e.g. this client didn't answer)

    const deltasJson = JSON.stringify(processed.entries.map((entry) => ({ otherUserId: entry.otherUserId, same: entry.same })))
    persistenceRoom.send('reportRound', { roundId: previousRoundId, deltasJson })
}
