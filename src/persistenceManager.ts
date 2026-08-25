import { getPlayer } from '@dcl/sdk/players'
import { myProfile } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import { persistenceRoom } from './persistenceMessages'
import { getRoundState, startRoundStateSync, SharedPhase, RoundStateValue } from './networkRoundState'
import { getAnswersForRound, AnswerOption } from './networkPlayerAnswer'
import { hydrateConnections } from './connectionsManager'
import { acknowledgeLevelWithoutCelebration } from './friendshipManager'
import {
    PersistedConnectionRecord,
    PersistedSocialQuestProfileV1,
    STORAGE_KEY,
    emptyProfile,
    sanitizeProfile,
    normalizeUserId,
    sortedPairKey,
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
 * sends. Combined with a roundId AND a sorted partner pair (sortedPairKey) to
 * build a globally-unique dedup key, so a restarted server that reissues
 * roundId 1 can never collide with a previous session's roundId 1, and a
 * round with several partners never lets a late-arriving pair's answer
 * overwrite or be blocked by an earlier pair's already-applied delta. Also
 * sent to the client in profileResponse - see tickPersistenceLoad's caller
 * for why the client needs it too (hydration-race reconciliation).
 */
const SERVER_SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/**
 * In-memory authoritative copy per player, for the lifetime of this server
 * process - the single source of truth applyDeltaToPlayer() reads its "current
 * state" from. Only ever updated by a successful, queued Storage.player.set()
 * commit (see applyDeltaToPlayer) - never mutated optimistically before Storage
 * confirms success, and never touched at all on failure. Combined with the
 * global write queue (every read-modify-write transaction for every player runs
 * inside the same FIFO), this guarantees a second delta for the same player -
 * another pair in the same RESULT scan, or a retry of this same pair on a later
 * tick - always builds on top of the last *confirmed* state, never a stale or
 * optimistic snapshot.
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

/**
 * Global write queue: guarantees this server process never has more than one
 * Storage.player.set() in flight at a time, no matter how many players/pairs
 * a single RESULT scan produces. Needed because the local preview's Storage
 * mock (sdk-commands' server-storage.json) does a non-atomic, whole-file
 * read-modify-write per call with no locking - two concurrent set() calls can
 * read the same stale snapshot and the second's write silently clobbers the
 * first's. Chaining every write through one FIFO promise tail serializes them
 * app-side regardless of what the storage backend itself does, so the same
 * protection also holds against production's real backend without needing to
 * assume anything about it.
 *
 * A rejected/failed task can never wedge the queue for later ones: the tail
 * is always advanced via a handler that resolves either way. In practice
 * saveProfile() never throws (it already catches internally and resolves to
 * false), so this is defense in depth, not the primary safety net.
 */
let saveQueueTail: Promise<unknown> = Promise.resolve()

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const runTask = saveQueueTail.then(task)
    saveQueueTail = runTask.then(
        () => undefined,
        () => undefined
    )
    return runTask
}

/** Outcome of one applyDeltaToPlayer() attempt - lets the caller (processRoundPair) tell a durable no-op apart from a fresh commit or a failure that should be retried on a later RESULT tick. */
type ApplyDeltaResult = 'SAVED' | 'ALREADY_PROCESSED' | 'FAILED'

/**
 * Applies one round's delta to a single player's own profile against `otherUserId`,
 * as a queued read-current -> build candidate -> commit-only-on-success transaction.
 * The canonical in-memory profile (serverProfiles) is never mutated optimistically -
 * only after Storage.player.set has actually confirmed success. On failure, nothing
 * about this player's state changes at all: not the counters, not
 * recentProcessedEventIds - so a later RESULT tick's rescan is free to retry this
 * exact eventId from scratch, with no separate retry system needed.
 *
 * The entire read-modify-write happens INSIDE the global write queue (enqueueWrite),
 * not just the final Storage.player.set call. This is what keeps multiple deltas for
 * the SAME player (e.g. A-B and A-C detected in the same RESULT scan, or this pair
 * rescanned on a later tick) from ever racing: each queued task re-reads
 * serverProfiles.get(address) at the moment it actually runs - its turn in the queue -
 * which by then already reflects every earlier-queued write for that player that has
 * committed, never a stale snapshot captured before this task was even enqueued.
 */
async function applyDeltaToPlayer(address: string, otherUserId: string, same: boolean, eventId: string): Promise<ApplyDeltaResult> {
    const baseline = await loadProfile(address)
    if (hasProcessedEventId(baseline, eventId)) return 'ALREADY_PROCESSED' // fast path - never even joins the queue

    return enqueueWrite(async (): Promise<ApplyDeltaResult> => {
        // Re-check against the CURRENT canonical profile, not `baseline` - it may have
        // advanced while this task was waiting its turn (another queued write for this
        // same player already committed).
        const current = serverProfiles.get(address) ?? baseline
        if (hasProcessedEventId(current, eventId)) return 'ALREADY_PROCESSED'

        const existing = current.connections[otherUserId] ?? { roundsTogether: 0, sameAnswers: 0, differentAnswers: 0 }
        const record: PersistedConnectionRecord = {
            roundsTogether: existing.roundsTogether + 1,
            sameAnswers: existing.sameAnswers + (same ? 1 : 0),
            differentAnswers: existing.differentAnswers + (same ? 0 : 1)
        }
        // A fresh object tree - current/serverProfiles is never touched unless this commits below.
        const candidate: PersistedSocialQuestProfileV1 = {
            version: current.version,
            connections: { ...current.connections, [otherUserId]: record },
            recentProcessedEventIds: [...current.recentProcessedEventIds]
        }
        pushProcessedEventId(candidate, eventId)

        // saveProfile() already logs a clear error on failure (returned false or threw) -
        // nothing further to log here on the failure path.
        const ok = await saveProfile(address, candidate)
        if (!ok) return 'FAILED'

        serverProfiles.set(address, candidate) // commit - only now does this become the canonical profile
        return 'SAVED'
    })
}

/**
 * Persists one validated pair's outcome for BOTH players symmetrically - each player's
 * own profile gets a delta against the other, under the exact same eventId. The pair is
 * only added to processedPairEventsInMemory (and so stops being rescanned) once BOTH
 * sides have durably landed (SAVED or ALREADY_PROCESSED) - if one side saved and the
 * other failed, the pair is rescanned again on the next RESULT tick: the succeeded side
 * takes its ALREADY_PROCESSED fast path (a no-op, never double-applies), while the
 * failed side gets a fresh attempt, exactly the natural retry the RESULT scanner
 * already provides every ~1s, with no new retry infrastructure.
 */
async function processRoundPair(roundId: number, userA: string, userB: string, same: boolean): Promise<void> {
    const eventId = `${SERVER_SESSION_ID}:${roundId}:${sortedPairKey(userA, userB)}`
    if (processedPairEventsInMemory.has(eventId)) return

    try {
        const [resultA, resultB] = await Promise.all([
            applyDeltaToPlayer(userA, userB, same, eventId),
            applyDeltaToPlayer(userB, userA, same, eventId)
        ])
        const doneA = resultA === 'SAVED' || resultA === 'ALREADY_PROCESSED'
        const doneB = resultB === 'SAVED' || resultB === 'ALREADY_PROCESSED'
        if (doneA && doneB) {
            processedPairEventsInMemory.add(eventId)
        } else {
            console.error(
                `[Persistence][SERVER] Pair ${userA} <-> ${userB} (round ${roundId}) not fully persisted yet (A=${resultA}, B=${resultB}) - will retry on a later RESULT tick`
            )
        }
    } catch (err) {
        console.error(`[Persistence][SERVER] Failed to process round ${roundId} pair: ${err instanceof Error ? err.message : String(err)}`)
    }
}

/**
 * Scans the CURRENT round's live synced answers (read-only - never writes to
 * RoundState/PlayerAnswer/PlayerSession) and persists every VALID pair not yet
 * seen this round.
 *
 * Validity intentionally mirrors connectionsManager.processRoundState()'s own
 * condition exactly, and nothing stricter: both users must have an answer
 * for this roundId that isn't AnswerOption.NO_ANSWER. Nothing here checks
 * getActiveUserIds() (CURRENT/live session eligibility) - connectionsManager
 * never does either, and doing so here would create a real gap: a player who
 * validly answered during ANSWERING but then left the Quest Zone (session
 * eligibility flips to not-joined) during or right after RESULT would still
 * have their Connection recorded client-side, but could be silently excluded
 * from persistence if this scan required current eligibility. A PlayerAnswer
 * entity for a given roundId only ever exists because publishPlayerAnswer()
 * was called while that client itself believed it was eligible (see
 * roundManager.maybePublishAnswer) - that is already the same trust boundary
 * the rest of this multiplayer architecture relies on, not something this
 * persistence layer needs to re-check on top. same/different is computed
 * here, from the real synced answers, never accepted from a client claim.
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

    const answers = getAnswersForRound(state.roundId).filter((answer) => answer.option !== AnswerOption.NO_ANSWER)

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
            persistenceRoom.send(
                'profileResponse',
                { found: true, dataJson: JSON.stringify(profile), error: '', serverSessionId: SERVER_SESSION_ID },
                { to: [context.from] }
            )
        } catch (err) {
            console.error(`[Persistence][SERVER] requestProfile handling failed: ${err instanceof Error ? err.message : String(err)}`)
            persistenceRoom.send('profileResponse', { found: false, dataJson: '', error: 'load_failed', serverSessionId: SERVER_SESSION_ID }, { to: [context.from] })
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

/** One round's outcome with one partner, observed locally while hydration was still pending - see tickPersistenceCapture(). Individual, not aggregated: two pending rounds with the same partner (one already server-persisted, one not) must be reconciled independently, not as a single "latest roundId" check - that would only correctly resolve the fully-confirmed or fully-unconfirmed cases, not a mix of both. */
interface PendingLocalEvent {
    otherUserId: string
    roundId: number
    same: boolean
}
/** Bounded in practice: only accumulates during the narrow pre-hydration window (LOAD is a single fast round-trip, most sessions never add anything here at all), and is fully drained/discarded the moment profileResponse arrives - never grows for the rest of the session. */
const pendingLocalEvents: PendingLocalEvent[] = []
/** Guards captureRoundEvents() so a roundId is only ever pushed into pendingLocalEvents once, however many times (periodic tick, one-time hydration flush) it's called for. */
const capturedRoundIds = new Set<number>()
let lastTrackedRoundId: number | null = null

/** Captures `roundId`'s valid pairings into pendingLocalEvents - shared by the periodic per-tick transition capture and the one-time flush at hydration time, deduped per-roundId (capturedRoundIds) so calling it from both never double-adds the same round. */
function captureRoundEvents(roundId: number): void {
    if (capturedRoundIds.has(roundId)) return
    capturedRoundIds.add(roundId)

    const answers = getAnswersForRound(roundId)
    const myAnswer = answers.find((answer) => answer.userId === myProfile.userId && answer.option !== AnswerOption.NO_ANSWER)
    if (!myAnswer) return // didn't answer that round - nothing to capture

    for (const other of answers) {
        if (other.userId === myProfile.userId) continue
        if (other.option === AnswerOption.NO_ANSWER) continue
        pendingLocalEvents.push({ otherUserId: other.userId, roundId, same: myAnswer.option === other.option })
    }
}

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
            // Flush: capture whatever round is currently the most recent one,
            // even if no LATER round has started yet to trigger the periodic
            // per-tick capture below. Without this, a round that finished
            // locally (already live in connectionsManager) right before this
            // response arrived - but before the NEXT round began - would never
            // make it into pendingLocalEvents at all. Capturing both
            // lastTrackedRoundId and a fresh getRoundState().roundId covers the
            // tick-vs-message-callback interleaving too; captureRoundEvents'
            // own per-roundId dedup means calling it twice here (or having the
            // periodic tick also call it later, if this ever ran before
            // hasHydrated was checked) can never double-add the same round.
            if (lastTrackedRoundId !== null) captureRoundEvents(lastTrackedRoundId)
            captureRoundEvents(getRoundState().roundId)

            const profile = sanitizeProfile(JSON.parse(data.dataJson))
            const myAddress = normalizeUserId(myProfile.userId)

            // Hydration race: LOAD is async and gameplay is never blocked on it,
            // so one or more rounds can genuinely complete locally with a
            // partner BEFORE this response arrives, while the server's OWN
            // independent round-detection (scanCurrentRoundForValidPairs above)
            // may have ALREADY persisted SOME of those same rounds (not
            // necessarily all - a later one can still be unconfirmed while an
            // earlier one already landed). Each pending event is reconstructed
            // and checked against the snapshot's own event log individually:
            // already-reflected events are dropped, genuinely-new ones are
            // applied - once, each - on top of the persisted baseline.
            const unconfirmedDeltas = new Map<string, { roundsTogether: number; sameAnswers: number; differentAnswers: number }>()
            for (const event of pendingLocalEvents) {
                const eventId = `${data.serverSessionId}:${event.roundId}:${sortedPairKey(myAddress, normalizeUserId(event.otherUserId))}`
                if (hasProcessedEventId(profile, eventId)) continue // already reflected in the snapshot we just received

                const delta = unconfirmedDeltas.get(event.otherUserId) ?? { roundsTogether: 0, sameAnswers: 0, differentAnswers: 0 }
                delta.roundsTogether += 1
                if (event.same) {
                    delta.sameAnswers += 1
                } else {
                    delta.differentAnswers += 1
                }
                unconfirmedDeltas.set(event.otherUserId, delta)
            }
            pendingLocalEvents.length = 0 // one-time reconciliation - discard regardless of outcome, never used again this session

            // Persisted baseline + only the unconfirmed remainder (possibly
            // zero) for each partner the snapshot already knows about. This is
            // already the fully-correct final total, so hydrateConnections is
            // told to REPLACE rather than add for every one of these - the
            // addition has already happened, once, right here.
            const records = Object.entries(profile.connections).map(([otherUserId, record]) => {
                const unconfirmed = unconfirmedDeltas.get(otherUserId)
                unconfirmedDeltas.delete(otherUserId)
                return {
                    otherUserId,
                    roundsTogether: record.roundsTogether + (unconfirmed?.roundsTogether ?? 0),
                    sameAnswers: record.sameAnswers + (unconfirmed?.sameAnswers ?? 0),
                    differentAnswers: record.differentAnswers + (unconfirmed?.differentAnswers ?? 0)
                }
            })
            // Any remaining unconfirmedDeltas belong to partners with pending
            // local events but no persisted history at all yet - nothing to
            // reconcile; the live local connections entry already correctly
            // reflects them, untouched, since it was never a `records` target.
            const replaceInstead = new Set(records.map((record) => record.otherUserId))

            const results = hydrateConnections(records, replaceInstead)
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
 * round could complete (though see profileResponse's hydration-race handling
 * above for what happens if one or more rounds finish locally before the
 * response arrives anyway). Never blocks or gates anything: if this never
 * fires (identity never resolves, message never arrives), the game simply
 * continues session-only, exactly like it does today.
 */
export function tickPersistenceLoad(): void {
    if (requestedProfile) return
    if (!isPersistenceEligible()) return
    requestedProfile = true
    persistenceRoom.send('requestProfile', {})
}

/**
 * Called once per tick from roundManager.tick(), only while hydration is still
 * pending (a no-op forever after, including for the rest of a session that
 * never even needed this). Independently observes the SAME synced
 * RoundState/PlayerAnswer this client's own connectionsManager.processRoundState()
 * already reads, purely to capture individual pre-hydration round outcomes
 * for the reconciliation above - never writes to connections, never triggers
 * a celebration, never duplicates connectionsManager's own bookkeeping
 * (lastProcessedRoundId, newConnectionsThisRound, etc.). connectionsManager's
 * own tick, wired separately in roundManager.tick(), is what actually drives
 * gameplay-visible Connections/Friendship - this is a read-only side observer
 * of the exact same source data, solely for this file's own reconciliation.
 */
export function tickPersistenceCapture(state: RoundStateValue): void {
    if (hasHydrated) return
    if (state.roundId === lastTrackedRoundId) return

    const previousRoundId = lastTrackedRoundId
    lastTrackedRoundId = state.roundId
    if (previousRoundId === null) return // first observation this session - nothing finished yet to capture

    captureRoundEvents(previousRoundId)
}
