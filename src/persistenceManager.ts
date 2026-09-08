import { getPlayer } from '@dcl/sdk/players'
import { myProfile } from '@dcl/sdk/network'
import { Storage } from '@dcl/sdk/server'
import { persistenceRoom } from './persistenceMessages'
import { getRoundState, startRoundStateSync, SharedPhase, RoundStateValue } from './networkRoundState'
import { getAnswersForRound, AnswerOption } from './networkPlayerAnswer'
import { hydrateConnections } from './connectionsManager'
import { hydrateUnseenConnections } from './socialNotificationsManager'
import { acknowledgeLevelWithoutCelebration, FRIENDSHIP_LEVELS, FriendshipLevelDefinition } from './friendshipManager'
import {
    PersistedConnectionRecord,
    PersistedSocialQuestProfileV1,
    STORAGE_KEY,
    emptyProfile,
    sanitizeProfile,
    sanitizeDisplayName,
    normalizeUserId,
    sortedPairKey,
    hasProcessedEventId,
    pushProcessedEventId,
    PersistedSocialPointsProfileV1,
    SOCIAL_POINTS_STORAGE_KEY,
    emptySocialPointsProfile,
    sanitizeSocialPointsProfile,
    hasProcessedSocialPointsEventId,
    pushProcessedSocialPointsEventId,
    friendshipBonusKey,
    PersistedSocialNotificationsProfileV1,
    SOCIAL_NOTIFICATIONS_STORAGE_KEY,
    emptySocialNotificationsProfile,
    sanitizeSocialNotificationsProfile,
    sanitizeConnectionIdList,
    MAX_MARK_SEEN_IDS_PER_REQUEST
} from './persistenceSchema'
import { enqueueWrite } from './storageWriteQueue'
import { scheduleLeaderboardSync, retryPendingLeaderboardSyncs, hydrateLeaderboardCache } from './leaderboardManager'
import { scheduleTopMatchSync, retryPendingTopMatchSyncs, hydrateTopMatchesCache } from './topMatchesManager'
import { getWeekKey } from './weekKey'
import { applyWeeklyPairEvent, hydrateTopMatchesWeeklyCache, checkTopMatchesWeeklyRollover } from './topMatchesWeeklyManager'

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
const loadingInFlight = new Map<string, Promise<ProfileLoadOutcome<PersistedSocialQuestProfileV1>>>()
/** Fast-path, in-memory-only record of round-pair events already handled THIS server process - avoids redundant work when the same pair is re-scanned on later RESULT ticks. Not the source of truth: each player's own persisted recentProcessedEventIds is, and is checked independently before every write, so this Set being empty on a fresh server boot is always safe. */
const processedPairEventsInMemory = new Set<string>()

/**
 * roundId -> weekKey, captured ONCE per round and never recalculated - see
 * captureRoundWeekKeyIfNeeded below. This is the piece that lets Top Matches
 * THIS WEEK (topMatchesWeeklyManager.ts) associate a round with the week it
 * actually happened in, rather than whatever week a later retry happens to
 * run in - RoundStateValue itself (networkRoundState.ts) carries no
 * timestamp, so this is server-only, in-memory bookkeeping, never synced to
 * clients and never a schema change to gameplay state. Bounded to the most
 * recent MAX_TRACKED_ROUND_WEEK_KEYS roundIds - a RESULT-tick rescan only
 * ever needs the current round's (or, briefly, the previous round's)
 * weekKey, never the entire session's history.
 */
const roundWeekKeys = new Map<number, string>()
const MAX_TRACKED_ROUND_WEEK_KEYS = 20

/**
 * Captures `state.roundId`'s weekKey the first time it's observed - preferring
 * the ANSWERING phase specifically, since that's the moment a roundId first
 * represents an actual new round (during WAITING/COUNTDOWN, `state.roundId`
 * still refers to the PREVIOUS completed round, not a new one about to
 * start - capturing then would attribute the wrong semantic moment). Falls
 * back to capturing on RESULT if ANSWERING was somehow never observed for
 * this roundId (e.g. the server started observing an already-in-progress
 * round right after a restart) - better than never capturing a weekKey for
 * that round at all. Once captured for a given roundId, never recalculated -
 * immune to how many times or how late a retry later re-reads it.
 */
function captureRoundWeekKeyIfNeeded(state: RoundStateValue): void {
    if (state.phase !== SharedPhase.ANSWERING && state.phase !== SharedPhase.RESULT) return
    if (roundWeekKeys.has(state.roundId)) return

    const weekKey = getWeekKey(Date.now())
    roundWeekKeys.set(state.roundId, weekKey)
    if (roundWeekKeys.size > MAX_TRACKED_ROUND_WEEK_KEYS) {
        const oldestRoundId = roundWeekKeys.keys().next().value
        if (oldestRoundId !== undefined) roundWeekKeys.delete(oldestRoundId)
    }
}

/**
 * Result of one profile load attempt (either domain - Connections or Social
 * Points). `loadedSuccessfully` is what every write path (applyDeltaToPlayer,
 * applySocialPointsEvent, awardFriendshipBonuses) MUST check before building
 * a Storage.player.set candidate on top of `profile` - see this file's own
 * data-integrity audit (loadProfile/loadSocialPointsProfile below).
 *
 * Deliberately a boolean, not a three-way 'loaded' | 'missing' | 'failed'
 * enum: nothing in this file ever needs to tell "real data" apart from
 * "confirmed no data yet" - both are equally safe to build a write candidate
 * on top of (a brand new player's very first round increments from
 * `{roundsTogether: 0, ...}` either way). The ONLY distinction that changes
 * behavior anywhere is "was the underlying Storage.player.get call itself
 * confirmed" (true for both LOADED and MISSING) vs "did it fail" (false) -
 * exactly what this one boolean encodes, with no unused states to keep in
 * sync.
 */
interface ProfileLoadOutcome<T> {
    profile: T
    loadedSuccessfully: boolean
}

/**
 * Loads `address`'s Connections profile, distinguishing a confirmed read
 * (real data, or confirmed-absent - raw === null - both `loadedSuccessfully:
 * true`) from a failed Storage.player.get (`loadedSuccessfully: false`).
 *
 * DATA-INTEGRITY INVARIANT: serverProfiles (the canonical in-memory cache
 * every write path reads its "current state" from) is ONLY EVER populated
 * from a confirmed read (this function's try branch) or a confirmed
 * Storage.player.set commit (applyDeltaToPlayer, after saveProfile succeeds).
 * NEVER from the catch branch below. This is what used to be missing: an
 * earlier version of this function cached an empty fallback profile on a
 * failed read, which every write path then unknowingly built a
 * Storage.player.set candidate on top of - permanently overwriting a
 * player's real persisted Connections with a truncated one the moment
 * Storage recovered. Not caching the failure fixes this at the one place
 * that matters, for every write path at once, without changing any of them
 * individually.
 *
 * A direct, useful consequence: a failed load is never remembered, so the
 * VERY NEXT call for the same address - the next RESULT-tick rescan calling
 * applyDeltaToPlayer again, or a later requestProfile - automatically
 * attempts a fresh Storage.player.get, with no separate "retry-eligible"
 * flag or bookkeeping needed. This is also why every existing retry
 * mechanism (RESULT-tick rescans, requestProfile-triggered reconciliation)
 * already suffices - none of them needed to change for this fix.
 */
async function loadProfile(address: string): Promise<ProfileLoadOutcome<PersistedSocialQuestProfileV1>> {
    const existing = serverProfiles.get(address)
    if (existing) return { profile: existing, loadedSuccessfully: true } // only ever cached from a confirmed read or a confirmed commit - see this function's own doc comment

    const inFlight = loadingInFlight.get(address)
    if (inFlight) return inFlight

    const promise = (async (): Promise<ProfileLoadOutcome<PersistedSocialQuestProfileV1>> => {
        try {
            const raw = await Storage.player.get<unknown>(address, STORAGE_KEY, { fresh: true })
            const profile = raw === null ? emptyProfile() : sanitizeProfile(raw)
            serverProfiles.set(address, profile) // confirmed read (LOADED or MISSING) - safe to cache and safe to write from
            return { profile, loadedSuccessfully: true }
        } catch (err) {
            console.error(
                `[Persistence][SERVER] Storage.player.get failed - this read is NOT cached and NOT safe to write from; the existing RESULT-tick rescan / requestProfile retry will attempt a fresh read: ${
                    err instanceof Error ? err.message : String(err)
                }`
            )
            // Deliberately NEVER serverProfiles.set() here - see this function's own
            // data-integrity invariant above. `profile` below is a throwaway value for
            // tolerant/read-only callers only (e.g. requestProfile's client response) -
            // never a valid baseline for a write.
            return { profile: emptyProfile(), loadedSuccessfully: false }
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

/** Outcome of one applyDeltaToPlayer() attempt - lets the caller (processRoundPair) tell a durable no-op apart from a fresh commit or a failure that should be retried on a later RESULT tick. */
type ApplyDeltaResult = 'SAVED' | 'ALREADY_PROCESSED' | 'FAILED'

/**
 * Result of one applyDeltaToPlayer() attempt, extended with the Friendship
 * milestones this specific delta just caused `address` to cross against
 * `otherUserId` - see crossedFriendshipMilestones(). Only ever non-empty when
 * result === 'SAVED': an ALREADY_PROCESSED outcome means this exact
 * pair-round was already fully handled by an earlier attempt (any crossing it
 * caused was already resolved then), and a FAILED outcome never touched
 * roundsTogether at all, so neither can have caused a fresh crossing.
 */
interface ApplyDeltaOutcome {
    result: ApplyDeltaResult
    crossedMilestones: FriendshipLevelDefinition[]
    /**
     * This address's own updated view of the relationship with `otherUserId`,
     * immediately after a fresh SAVED commit - undefined for ALREADY_PROCESSED/
     * FAILED (nothing new to report). Feeds Top Matches' pair-level sync (see
     * processRoundPair/scheduleTopMatchSync) - each side's own sameAnswers/
     * differentAnswers view IS a valid absolute snapshot for the pair, since a
     * "same answer" round is the same fact from either side's perspective.
     */
    connectionSnapshot?: { sameAnswers: number; differentAnswers: number }
    /**
     * True only when this exact commit is the FIRST time `address` has ever
     * had a Connection with `otherUserId` - captured from whether
     * current.connections[otherUserId] was undefined BEFORE this delta built
     * its `existing` fallback, never a change to Connections' own semantics.
     * Only ever meaningful (and only ever true) alongside result === 'SAVED' -
     * ALREADY_PROCESSED means an earlier attempt already reported this, and
     * FAILED never touched roundsTogether at all. This is the ONE and ONLY
     * signal processRoundPair uses to feed Social Notifications' unseen list
     * (addUnseenConnection below) - hydration/reconciliation never call this
     * function at all, so they structurally can never produce a false isNew.
     */
    isNew: boolean
}

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
async function applyDeltaToPlayer(
    address: string,
    otherUserId: string,
    same: boolean,
    eventId: string,
    /** The OTHER player's display name, as observed by THIS server right now via getPlayer() - already sanitized (non-empty, trimmed) by the caller, or undefined if unresolved this tick. Never a client-claimed value. */
    observedDisplayName: string | undefined
): Promise<ApplyDeltaOutcome> {
    const { profile: baseline, loadedSuccessfully } = await loadProfile(address)
    if (!loadedSuccessfully) {
        // The Storage.player.get itself failed - `baseline` is a throwaway empty
        // profile, NOT a confirmed state (see loadProfile's own data-integrity
        // invariant). Abort without touching Storage or serverProfiles at all: never
        // increment roundsTogether, never write Connections from this unreliable
        // baseline. The existing RESULT-tick rescan (scanCurrentRoundForValidPairs)
        // calls this again on the next tick, which attempts a genuinely fresh read -
        // a failed load is never cached, so no separate retry bookkeeping is needed.
        return { result: 'FAILED', crossedMilestones: [], isNew: false }
    }
    if (hasProcessedEventId(baseline, eventId)) return { result: 'ALREADY_PROCESSED', crossedMilestones: [], isNew: false } // fast path - never even joins the queue

    return enqueueWrite(async (): Promise<ApplyDeltaOutcome> => {
        // Re-check against the CURRENT canonical profile, not `baseline` - it may have
        // advanced while this task was waiting its turn (another queued write for this
        // same player already committed). Guaranteed present by now: `loadedSuccessfully`
        // above already confirms serverProfiles.get(address) was populated.
        const current = serverProfiles.get(address) ?? baseline
        if (hasProcessedEventId(current, eventId)) return { result: 'ALREADY_PROCESSED', crossedMilestones: [], isNew: false }

        // Captured BEFORE the `existing` fallback below papers over "no record yet"
        // with a zeroed placeholder - this is the one and only moment this delta can
        // tell "brand new partner" apart from "existing partner, one more round". See
        // ApplyDeltaOutcome.isNew's own doc comment for why this never changes
        // Connections' own semantics.
        const isNewOnServer = current.connections[otherUserId] === undefined
        const existing = current.connections[otherUserId] ?? { roundsTogether: 0, sameAnswers: 0, differentAnswers: 0 }
        const record: PersistedConnectionRecord = {
            roundsTogether: existing.roundsTogether + 1,
            sameAnswers: existing.sameAnswers + (same ? 1 : 0),
            differentAnswers: existing.differentAnswers + (same ? 0 : 1),
            // Only ever overwritten by a freshly-observed valid name this tick - a
            // temporarily unresolved observation (undefined) always falls back to
            // whatever was already stored, never regresses to "no name".
            lastKnownDisplayName: observedDisplayName ?? existing.lastKnownDisplayName
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
        if (!ok) return { result: 'FAILED', crossedMilestones: [], isNew: false }

        serverProfiles.set(address, candidate) // commit - only now does this become the canonical profile
        return {
            result: 'SAVED',
            crossedMilestones: crossedFriendshipMilestones(existing.roundsTogether, record.roundsTogether),
            connectionSnapshot: { sameAnswers: record.sameAnswers, differentAnswers: record.differentAnswers },
            isNew: isNewOnServer
        }
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
async function processRoundPair(
    roundId: number,
    userA: string,
    userB: string,
    same: boolean,
    /** Names observed by THIS server right now, already sanitized - nameA is A's own name (goes into B's record about A), nameB is B's own name (goes into A's record about B). Never client-claimed. */
    nameA: string | undefined,
    nameB: string | undefined
): Promise<void> {
    const eventId = `${SERVER_SESSION_ID}:${roundId}:${sortedPairKey(userA, userB)}`
    if (processedPairEventsInMemory.has(eventId)) return

    try {
        const [outcomeA, outcomeB] = await Promise.all([
            applyDeltaToPlayer(userA, userB, same, eventId, nameB), // A's record ABOUT B stores B's name
            applyDeltaToPlayer(userB, userA, same, eventId, nameA) // B's record ABOUT A stores A's name
        ])
        const doneA = outcomeA.result === 'SAVED' || outcomeA.result === 'ALREADY_PROCESSED'
        const doneB = outcomeB.result === 'SAVED' || outcomeB.result === 'ALREADY_PROCESSED'
        if (doneA && doneB) {
            processedPairEventsInMemory.add(eventId)
        } else {
            console.error(
                `[Persistence][SERVER] Pair ${userA} <-> ${userB} (round ${roundId}) not fully persisted yet (A=${outcomeA.result}, B=${outcomeB.result}) - will retry on a later RESULT tick`
            )
        }

        // Friendship bonuses - own separate write queue entries, fire-and-forget so a
        // slow/failed bonus write never delays marking this pair processed above. Safe
        // to run concurrently with a reconciliation sweep for either address - see
        // awardFriendshipBonuses's own doc comment for why the two can never double-pay
        // the same milestone.
        if (outcomeA.crossedMilestones.length > 0) {
            void awardFriendshipBonuses(
                userA,
                outcomeA.crossedMilestones.map((definition) => ({ key: friendshipBonusKey(userB, definition.id), bonusPoints: definition.bonusPoints }))
            )
        }
        // Social Notifications - own separate domain/write, fire-and-forget, same
        // reasoning as the Friendship bonuses above. Only ever fired on a fresh
        // SAVED + isNew (see ApplyDeltaOutcome.isNew's own doc comment) - never on
        // ALREADY_PROCESSED (an earlier attempt already reported this) or on a
        // rescanned/existing partner. Symmetric: A gets B added to A's own unseen
        // list, B gets A added to B's own unseen list.
        if (outcomeA.result === 'SAVED' && outcomeA.isNew) {
            void addUnseenConnection(userA, userB)
        }
        if (outcomeB.result === 'SAVED' && outcomeB.isNew) {
            void addUnseenConnection(userB, userA)
        }

        if (outcomeB.crossedMilestones.length > 0) {
            void awardFriendshipBonuses(
                userB,
                outcomeB.crossedMilestones.map((definition) => ({ key: friendshipBonusKey(userA, definition.id), bonusPoints: definition.bonusPoints }))
            )
        }

        // Top Matches (ALL TIME) - deliberately NOT gated on "only the canonical/
        // smaller-userId side". EITHER side's own fresh SAVED commit is a valid
        // absolute snapshot of the pair, and scheduleTopMatchSync's monotonic
        // merge (see topMatchesManager.ts) guarantees that whichever side is
        // currently more advanced always wins - never two entries for the same
        // pair, never a regression if one side is temporarily behind.
        if (outcomeA.result === 'SAVED' && outcomeA.connectionSnapshot) {
            scheduleTopMatchSync(userA, userB, outcomeA.connectionSnapshot, nameA, nameB)
        }
        if (outcomeB.result === 'SAVED' && outcomeB.connectionSnapshot) {
            scheduleTopMatchSync(userB, userA, outcomeB.connectionSnapshot, nameB, nameA)
        }
    } catch (err) {
        console.error(`[Persistence][SERVER] Failed to process round ${roundId} pair: ${err instanceof Error ? err.message : String(err)}`)
    }
}

/**
 * Resolves the AUTHORITATIVE SERVER's own current observation of `userId`'s
 * display name - getPlayer() here reads this server's own ECS state
 * (PlayerIdentityData/AvatarBase, populated by the platform's comms/identity
 * sync for every connected peer, server included - see the investigation this
 * is based on), never anything a client explicitly sends. AvatarBase.name can
 * be an empty string if that component hasn't synced yet even though the
 * player is otherwise present - sanitizeDisplayName treats that exactly like
 * "unresolved" (undefined), never as a real name, and this function
 * deliberately never substitutes an artificial fallback like "Player" -
 * callers fall back to whatever was already stored instead.
 */
function resolveObservedDisplayName(userId: string): string | undefined {
    return sanitizeDisplayName(getPlayer({ userId })?.name)
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

    // The single canonical observation of this roundId's weekKey - captured once,
    // at the first ANSWERING (or, exceptionally, first-ever) observation of this
    // roundId, by captureRoundWeekKeyIfNeeded() in the tick below. The `?? getWeekKey(Date.now())`
    // fallback only matters if that capture was somehow missed entirely - it should
    // never be needed in practice, but never blocks weekly processing if it is.
    const weekKey = roundWeekKeys.get(state.roundId) ?? getWeekKey(Date.now())
    const answers = getAnswersForRound(state.roundId).filter((answer) => answer.option !== AnswerOption.NO_ANSWER)

    for (let i = 0; i < answers.length; i++) {
        for (let j = i + 1; j < answers.length; j++) {
            const a = answers[i]
            const b = answers[j]
            // Resolved from the RAW (non-normalized) userId - PlayerIdentityData.address
            // is the real, case-preserved address; normalizeUserId's lowercasing is a
            // persistence-layer-only convention for the Storage key, not what getPlayer()
            // matches against.
            const nameA = resolveObservedDisplayName(a.userId)
            const nameB = resolveObservedDisplayName(b.userId)
            const same = a.option === b.option
            void processRoundPair(state.roundId, normalizeUserId(a.userId), normalizeUserId(b.userId), same, nameA, nameB)

            // Top Matches THIS WEEK - a fully separate domain from Connections/ALL TIME
            // above, fed by the SAME single canonical observation of this pair/round
            // (same `same` boolean, no recomputation) but processed independently: its
            // own eventId, own dedup, own Storage key, own failure handling. A failure
            // here can never affect processRoundPair above, and vice versa - see
            // topMatchesWeeklyManager.ts's own file-level doc comment.
            const weeklyEventId = `${weekKey}:${SERVER_SESSION_ID}:${state.roundId}:${sortedPairKey(a.userId, b.userId)}`
            void applyWeeklyPairEvent(weekKey, normalizeUserId(a.userId), normalizeUserId(b.userId), same, weeklyEventId, nameA, nameB)
        }
    }
}

// ---------------------------------------------------------------------------
// SOCIAL POINTS (Phase 1) - a fully independent domain from Connections above.
// Separate Storage key, separate in-memory canonical map, separate dedupe
// list and in-memory processed-set. The ONE thing deliberately shared with
// Connections is the write queue (enqueueWrite/saveQueueTail, defined above)
// - every Storage.player.set() in this file, for either domain, runs through
// that same FIFO, so the two domains can never have overlapping writes in
// flight. Nothing else about Connections is read, written, or assumed here.
// ---------------------------------------------------------------------------

/** In-memory canonical Social Points profile per player, same role/guarantees as serverProfiles above: only ever updated after a queued Storage.player.set() confirms success. */
const socialPointsProfiles = new Map<string, PersistedSocialPointsProfileV1>()
/** Addresses currently mid-load, mirrors loadingInFlight above but for this separate domain. */
const socialPointsLoadingInFlight = new Map<string, Promise<ProfileLoadOutcome<PersistedSocialPointsProfileV1>>>()
/** Fast-path in-memory record of per-player roundEventIds already handled THIS server process - mirrors processedPairEventsInMemory above, own Set. */
const processedSocialPointsEventsInMemory = new Set<string>()

/**
 * Every Friendship milestone crossed by roundsTogether going from `previous`
 * to `current` (current > previous) - i.e. every FRIENDSHIP_LEVELS definition
 * whose threshold satisfies previous < minRounds <= current. Used both by the
 * immediate single-partner check (applyDeltaToPlayer, where a round only ever
 * advances roundsTogether by 1, so at most one crossing) and by the full
 * reconciliation sweep (reconcileFriendshipBonuses, where `previous` is always
 * 0 - every threshold already reached becomes "crossed" at once, which is what
 * makes historical bonuses retroactive by product decision).
 */
function crossedFriendshipMilestones(previousRoundsTogether: number, currentRoundsTogether: number): FriendshipLevelDefinition[] {
    return FRIENDSHIP_LEVELS.filter((definition) => previousRoundsTogether < definition.minRounds && currentRoundsTogether >= definition.minRounds)
}

/** One Friendship milestone bonus a player may be due, resolved by the caller (applyDeltaToPlayer's crossing check or reconcileFriendshipBonuses' full sweep) - never trusted past the queued re-check inside awardFriendshipBonuses below. */
interface DueFriendshipBonus {
    key: string
    bonusPoints: number
}

/**
 * Grants every bonus in `dueBonuses` that this player's CURRENT canonical
 * Social Points profile hasn't already recorded, as a single queued
 * read-check-write transaction - same shape as applySocialPointsEvent,
 * generalized to N milestones at once (a full reconciliation sweep can find
 * several due bonuses for one player in one pass; a live crossing typically
 * finds one). Re-checks awardedFriendshipBonuses against the CURRENT profile,
 * never a snapshot taken before this was enqueued - so this can safely be
 * called concurrently from both the immediate crossing-detection path
 * (processRoundPair) and a full reconciliation sweep
 * (reconcileFriendshipBonuses) for the same address without ever double-paying
 * the same key: whichever call's turn in the shared write queue comes first
 * wins and marks the key, the other sees it already recorded and no-ops for
 * it. On failure, nothing about this player's state changes at all - not
 * friendshipBonusPoints, not awardedFriendshipBonuses - so any future
 * crossing or reconciliation sweep is free to retry the still-missing keys
 * from scratch. Returns false only when a write was actually attempted and
 * failed - true for "nothing was due" and for a confirmed save, so callers
 * that need to know whether it's now safe to stop retrying (reconcileFriendshipBonuses)
 * can tell the difference from "there was nothing to do".
 */
async function awardFriendshipBonuses(address: string, dueBonuses: DueFriendshipBonus[]): Promise<boolean> {
    if (dueBonuses.length === 0) return true

    const { profile: baseline, loadedSuccessfully } = await loadSocialPointsProfile(address)
    if (!loadedSuccessfully) {
        console.error(`[SocialPoints][SERVER] Friendship bonus award for ${address} deferred - Social Points profile failed to load, not writing from an unreliable baseline`)
        // Same recovery path as the write-failure branch below - queue for the next
        // tick's retry rather than silently dropping these bonuses. A fresh
        // loadSocialPointsProfile() attempt on that retry gets a genuinely new read,
        // since a failed load is never cached (see loadSocialPointsProfile's own doc
        // comment).
        reconciledAddresses.delete(address)
        pendingFriendshipReconciliations.add(address)
        return false
    }
    if (dueBonuses.every((bonus) => bonus.key in baseline.awardedFriendshipBonuses)) return true // fast path - never even joins the queue

    return enqueueWrite(async (): Promise<boolean> => {
        const current = socialPointsProfiles.get(address) ?? baseline
        const stillDue = dueBonuses.filter((bonus) => !(bonus.key in current.awardedFriendshipBonuses))
        if (stillDue.length === 0) return true

        const awardedFriendshipBonuses = { ...current.awardedFriendshipBonuses }
        let addedPoints = 0
        for (const bonus of stillDue) {
            awardedFriendshipBonuses[bonus.key] = true
            addedPoints += bonus.bonusPoints
        }

        // A fresh object tree - current/socialPointsProfiles is never touched unless this commits below.
        const candidate: PersistedSocialPointsProfileV1 = {
            version: current.version,
            validRounds: current.validRounds,
            friendshipBonusPoints: current.friendshipBonusPoints + addedPoints,
            awardedFriendshipBonuses,
            recentProcessedEventIds: current.recentProcessedEventIds
        }

        const ok = await saveSocialPointsProfile(address, candidate)
        if (!ok) {
            console.error(`[SocialPoints][SERVER] Failed to save ${stillDue.length} Friendship bonus(es) for ${address} - will retry on a later tick`)
            // This write may have been the one reconcileFriendshipBonuses was counting on
            // to mark `address` fully reconciled - un-mark it so a stale "already
            // reconciled" flag can never suppress the retry this failure needs.
            // Queuing it here (rather than only relying on a future requestProfile) is
            // what lets recovery happen while this server process stays alive, with no
            // reconnect and no restart required - see retryPendingFriendshipBonuses.
            reconciledAddresses.delete(address)
            pendingFriendshipReconciliations.add(address)
            return false
        }

        socialPointsProfiles.set(address, candidate) // commit - only now does this become the canonical profile
        // Keeps the leaderboard mirror converging on live Friendship bonuses, not
        // just live validRounds - same absolute-snapshot contract as
        // applySocialPointsEvent's own call, own separate trigger. See
        // scheduleLeaderboardSync's own doc comment.
        scheduleLeaderboardSync(address, candidate.validRounds, candidate.friendshipBonusPoints, resolveObservedDisplayName(address))
        return true
    })
}

/** Addresses whose full historical Friendship-bonus reconciliation sweep has completed successfully this server process - see reconcileFriendshipBonuses. Only ever added on a confirmed success, never on failure, so a recoverable Storage error doesn't permanently block retrying for the rest of this process's lifetime. */
const reconciledAddresses = new Set<string>()
/** Addresses whose sweep is currently running - guards a second concurrent requestProfile for the same address (e.g. a fast reconnect) from starting a redundant sweep while the first is still in flight. Always cleared, success or failure. */
const reconciliationInFlight = new Set<string>()
/**
 * Addresses with at least one failed awardFriendshipBonuses write, to retry on
 * a later tick while this server process stays alive - mirrors
 * leaderboardManager.ts's own pendingLeaderboardSyncs retry pattern. Populated
 * only by awardFriendshipBonuses' own failure branch above; never itself a
 * source of truth for what's owed - retryPendingFriendshipBonuses always
 * re-derives that from the player's persisted Connections + Social Points
 * profiles via a fresh reconcileFriendshipBonuses call, never from whatever
 * dueBonuses the original failed attempt happened to be carrying.
 */
const pendingFriendshipReconciliations = new Set<string>()

/**
 * Full historical reconciliation for one player, run at most once successfully
 * per address per server process (reconciledAddresses/reconciliationInFlight
 * above). Makes Friendship bonuses retroactive for a player whose Connections
 * history already passed a threshold before this bonus existed, or whose bonus
 * was missed by a failed write on the immediate crossing-detection path
 * (processRoundPair) and never retried because that exact pair happened not to
 * play another round together since.
 *
 * Reads the player's OWN two profiles only - Connections (roundsTogether per
 * partner) and Social Points (awardedFriendshipBonuses) - via the SAME address,
 * never another player's data, so there is no cross-player dependency here at
 * all. For every partner, every milestone already reached (previous=0, so
 * everything up to the partner's current roundsTogether) that isn't yet in
 * awardedFriendshipBonuses is queued as due - this is what makes a long
 * pre-existing history (e.g. 67 roundsTogether with no bonuses recorded yet)
 * pay out every already-earned milestone at once, permanently.
 *
 * Deliberately fire-and-forget from its caller (the requestProfile handler) -
 * never blocks or delays that response, which only needs the Connections
 * profile it already awaited. Safe to run concurrently with the immediate
 * crossing-detection path for the same address - see awardFriendshipBonuses's
 * own doc comment.
 *
 * Takes the Connections profile and its load status as PARAMETERS rather than
 * loading them itself - the caller (requestProfile handler, or
 * retryFriendshipReconciliationForAddress on the pending-write retry tick)
 * has always already resolved both, and re-loading here would duplicate a
 * Storage read that just happened moments earlier (see loadProfile's own doc
 * comment). If `connectionsLoadedSuccessfully` is false - the read that
 * produced `connectionsProfile` was a failure fallback, not real data - this
 * sweep does nothing at all: it neither awards
 * anything (an empty fallback would look like "no Friendship history",
 * silently skipping every already-earned bonus) nor marks the address
 * reconciled, so a later requestProfile (or retry tick) gets a genuine second
 * attempt instead of being permanently skipped by a false "already done".
 */
async function reconcileFriendshipBonuses(address: string, connectionsProfile: PersistedSocialQuestProfileV1, connectionsLoadedSuccessfully: boolean): Promise<void> {
    if (reconciledAddresses.has(address)) return
    if (reconciliationInFlight.has(address)) return
    if (!connectionsLoadedSuccessfully) {
        console.error(`[SocialPoints][SERVER] Friendship bonus reconciliation skipped for ${address} - Connections profile failed to load this attempt, eligible for retry later`)
        return
    }
    reconciliationInFlight.add(address)

    try {
        const dueBonuses: DueFriendshipBonus[] = []
        for (const [partnerUserId, record] of Object.entries(connectionsProfile.connections)) {
            for (const definition of crossedFriendshipMilestones(0, record.roundsTogether)) {
                dueBonuses.push({ key: friendshipBonusKey(partnerUserId, definition.id), bonusPoints: definition.bonusPoints })
            }
        }

        const saved = await awardFriendshipBonuses(address, dueBonuses)
        if (saved) {
            reconciledAddresses.add(address) // only marked done once the sweep's own write (if any) actually confirmed
        } else {
            console.error(`[SocialPoints][SERVER] Friendship bonus reconciliation for ${address} did not fully save - eligible for retry on a later requestProfile`)
        }
    } catch (err) {
        console.error(`[SocialPoints][SERVER] Friendship bonus reconciliation failed for ${address} - eligible for retry on a later requestProfile: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
        reconciliationInFlight.delete(address)
    }
}

/**
 * Re-derives a fresh Connections load (via loadProfile - a genuinely fresh
 * attempt if the last one failed, since a failed load is never cached) before
 * retrying reconcileFriendshipBonuses - used only by
 * retryPendingFriendshipBonuses below, where genuine time has passed since
 * the last attempt (a full server tick), unlike the requestProfile handler,
 * which already has a same-instant profile+status to pass directly.
 */
async function retryFriendshipReconciliationForAddress(address: string): Promise<void> {
    const { profile, loadedSuccessfully } = await loadProfile(address)
    await reconcileFriendshipBonuses(address, profile, loadedSuccessfully)
}

/**
 * Retries every address flagged by a failed awardFriendshipBonuses write, once
 * per server tick (same 1s cadence as retryPendingLeaderboardSyncs and the
 * RESULT scans - see initPersistenceServer) - this is the automatic-recovery
 * half of the failure path above, so a transient Storage outage never needs a
 * server restart (or even that player reconnecting) to resolve itself.
 *
 * Drains the pending set into a local snapshot BEFORE retrying, rather than
 * checking membership after each attempt - a retry that fails re-adds its own
 * address via awardFriendshipBonuses' failure branch, so this never loses
 * track of a still-failing address, and never needs to distinguish "still
 * pending" from "freshly failed again" itself. Never throws, never grows
 * unbounded, and never fires more than once per tick even if Storage stays
 * down indefinitely - the same natural, non-aggressive cadence every other
 * retry in this file already relies on.
 *
 * Each retry re-runs the FULL reconcileFriendshipBonuses sweep for that
 * address rather than replaying the specific bonus that failed - it re-derives
 * what's due entirely from the player's own persisted Connections and Social
 * Points profiles, never from the transient crossing data that triggered the
 * original attempt, so a retry is exactly as correct as a fresh reconnect
 * would have been. reconcileFriendshipBonuses' own reconciliationInFlight
 * guard already prevents two concurrent attempts for the same address, so this
 * never needs its own separate one.
 */
function retryPendingFriendshipBonuses(): void {
    if (pendingFriendshipReconciliations.size === 0) return
    const addresses = [...pendingFriendshipReconciliations]
    pendingFriendshipReconciliations.clear()
    for (const address of addresses) {
        void retryFriendshipReconciliationForAddress(address)
    }
}

/** Addresses whose full Top Matches reconciliation sweep (from persisted Connections) has completed successfully this server process - mirrors reconciledAddresses (Friendship bonuses), own separate Set/domain. Only ever added once the sweep itself ran to completion without throwing - see reconcileTopMatchesForAddress. */
const reconciledTopMatchAddresses = new Set<string>()
/** Addresses whose Top Matches sweep is currently running - guards a second concurrent requestProfile for the same address (e.g. a fast reconnect) from redundantly re-scheduling every partner's snapshot while the first sweep is still in flight. Not required for correctness (scheduleTopMatchSync's monotonic merge tolerates redundant calls perfectly safely) - purely to avoid wasted work. Always cleared, success or failure. */
const topMatchReconciliationInFlight = new Set<string>()

/**
 * Full historical Top Matches reconciliation for one player, run at most once
 * successfully per address per server process (reconciledTopMatchAddresses/
 * topMatchReconciliationInFlight above) - mirrors reconcileFriendshipBonuses'
 * own shape and role, own separate domain, triggered from the same
 * requestProfile handler.
 *
 * Resolves two things at once, by design:
 * - BACKFILL: a Connection formed before Top Matches existed never generated
 *   any global pair entry - the live path (processRoundPair) only fires on a
 *   FRESH round. This sweep is what lets that pre-existing history enter the
 *   index, the moment either member of the pair next reconnects.
 * - RECOVERY: if a live scheduleTopMatchSync's eventual Storage.set was lost
 *   to a server restart before it flushed (its pending entry only ever lived
 *   in memory - see topMatchesManager.ts), this sweep re-derives and re-sends
 *   the exact same absolute snapshot from this player's own already-confirmed
 *   Connections profile, with no dependency on that specific pair ever
 *   playing another round.
 *
 * NEVER writes to the Top Matches index directly - every partner's snapshot
 * goes through the exact same scheduleTopMatchSync() the live round path
 * uses, so it gets the identical pairKey computation, monotonic merge, and
 * pending/retry handling. This is what makes it safe for BOTH members of a
 * pair to reconcile the same relationship independently, whenever each of
 * them next reconnects - scheduleTopMatchSync's max() merge means whichever
 * sweep (or the live path) has seen the higher counters always wins, never
 * overwritten by a lower one arriving later, in either order.
 *
 * Marked reconciled once every partner has been HANDED to scheduleTopMatchSync
 * - not once each one's eventual Storage.set has confirmed. That's correct
 * (not a shortcut): scheduleTopMatchSync is synchronous bookkeeping only (it
 * updates the in-memory pending map and asks for a flush) - the actual
 * Storage.set and its retry-on-failure are topMatchesManager.ts's own,
 * already-proven responsibility, wired independently into every server tick.
 * The try/catch below is defensive only (nothing inside currently throws,
 * since the Connections load itself already happened in the caller) - kept
 * for the same reason reconcileFriendshipBonuses keeps one, and specifically
 * NOT followed by marking this address reconciled on the (currently
 * unreachable) failure path, so a later requestProfile would still retry the
 * whole sweep from scratch if that ever changed.
 *
 * Own display name is resolved ONCE via resolveObservedDisplayName and reused
 * for every partner in the loop - reliable at exactly this moment because
 * this function is only ever triggered by that same player's OWN
 * requestProfile message, so they are by definition currently connected (see
 * this function's call site). The partner's name comes from whatever this
 * player's own Connections profile already persisted for them
 * (lastKnownDisplayName) - no new persisted field needed for either side.
 *
 * Takes the Connections profile and its load status as PARAMETERS, exactly
 * like reconcileFriendshipBonuses now does - the requestProfile handler has
 * already resolved both via loadProfile, so this never re-reads Storage
 * itself. If `connectionsLoadedSuccessfully` is false, this does
 * nothing: no partner is scheduled (an empty fallback profile would look
 * like "this player has no history", silently regressing nothing thanks to
 * scheduleTopMatchSync's monotonic merge - but it's still pointless work) and
 * the address is NOT marked reconciled, so a later requestProfile gets a
 * genuine retry instead of being permanently skipped.
 */
async function reconcileTopMatchesForAddress(
    address: string,
    connectionsProfile: PersistedSocialQuestProfileV1,
    connectionsLoadedSuccessfully: boolean
): Promise<void> {
    if (reconciledTopMatchAddresses.has(address)) return
    if (topMatchReconciliationInFlight.has(address)) return
    if (!connectionsLoadedSuccessfully) {
        console.error(`[TopMatches][SERVER] Reconciliation skipped for ${address} - Connections profile failed to load this attempt, eligible for retry later`)
        return
    }
    topMatchReconciliationInFlight.add(address)

    try {
        const ownDisplayName = resolveObservedDisplayName(address)

        for (const [partnerUserId, record] of Object.entries(connectionsProfile.connections)) {
            scheduleTopMatchSync(
                address,
                partnerUserId,
                { sameAnswers: record.sameAnswers, differentAnswers: record.differentAnswers },
                ownDisplayName,
                record.lastKnownDisplayName
            )
        }

        reconciledTopMatchAddresses.add(address)
    } catch (err) {
        console.error(`[TopMatches][SERVER] Reconciliation failed for ${address} - eligible for retry on a later requestProfile: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
        topMatchReconciliationInFlight.delete(address)
    }
}

/**
 * Progressive, per-player backfill for the leaderboard mirror - called once
 * per requestProfile (i.e. once per player connect/reconnect), fire-and-
 * forget, never blocking the profileResponse above. This is what repairs an
 * entry written before friendshipBonusPoints existed on the mirror (sanitized
 * to 0 by leaderboardSchema.ts) without a global sweep of every player: each
 * returning player's own connect naturally converges their own entry to the
 * real Social Points profile, one player at a time, no new retry
 * infrastructure needed - a stale entry simply gets fixed the next time that
 * player happens to reconnect.
 *
 * Reuses loadSocialPointsProfile()'s own cache/in-flight dedupe (see that
 * function's doc comment) rather than issuing its own Storage.player.get -
 * this never causes a second concurrent read for the same address even when
 * awardFriendshipBonuses' own internal load (inside a same-tick
 * reconcileFriendshipBonuses sweep) is racing this exact call; both share the
 * same cache entry or in-flight promise.
 *
 * Skips entirely when the Social Points read itself failed - per this file's
 * data-integrity invariant (loadSocialPointsProfile's own doc comment), a
 * failed read must never be treated as "friendshipBonusPoints is 0": doing so
 * would overwrite a returning player's real bonus history with a false zero
 * on the mirror the moment Storage had one bad read. A later requestProfile
 * (this player's next reconnect) gets a genuinely fresh attempt.
 *
 * Also skips when the profile has nothing to show yet (validRounds === 0 AND
 * friendshipBonusPoints === 0) - a brand new player who has never played a
 * round has never had a leaderboard entry either (scheduleLeaderboardSync is
 * otherwise only ever called after a real round or bonus), and this backfill
 * is not meant to start creating zero-value entries for every connect.
 */
async function reconcileLeaderboardSnapshot(address: string): Promise<void> {
    const { profile, loadedSuccessfully } = await loadSocialPointsProfile(address)
    if (!loadedSuccessfully) {
        console.error(`[Leaderboard][SERVER] Snapshot reconciliation skipped for ${address} - Social Points profile failed to load this attempt, eligible for retry on a later requestProfile`)
        return
    }
    if (profile.validRounds === 0 && profile.friendshipBonusPoints === 0) return

    scheduleLeaderboardSync(address, profile.validRounds, profile.friendshipBonusPoints, resolveObservedDisplayName(address))
}

/**
 * Loads `address`'s Social Points profile with the same LOADED/MISSING vs
 * FAILED distinction as loadProfile() (Connections) above - see that
 * function's own doc comment for the full data-integrity invariant this
 * enforces: socialPointsProfiles is ONLY EVER populated from a confirmed read
 * or a confirmed Storage.player.set commit, NEVER from a failed
 * Storage.player.get's catch branch. Without this, applySocialPointsEvent and
 * awardFriendshipBonuses would each unknowingly build a write candidate on
 * top of an empty fallback the moment Storage.player.get failed once,
 * permanently overwriting validRounds/friendshipBonusPoints/
 * awardedFriendshipBonuses with a truncated profile as soon as either of
 * them next wrote - the exact risk this whole function exists to prevent.
 */
async function loadSocialPointsProfile(address: string): Promise<ProfileLoadOutcome<PersistedSocialPointsProfileV1>> {
    const existing = socialPointsProfiles.get(address)
    if (existing) return { profile: existing, loadedSuccessfully: true }

    const inFlight = socialPointsLoadingInFlight.get(address)
    if (inFlight) return inFlight

    const promise = (async (): Promise<ProfileLoadOutcome<PersistedSocialPointsProfileV1>> => {
        try {
            const raw = await Storage.player.get<unknown>(address, SOCIAL_POINTS_STORAGE_KEY, { fresh: true })
            const profile = raw === null ? emptySocialPointsProfile() : sanitizeSocialPointsProfile(raw)
            socialPointsProfiles.set(address, profile) // confirmed read (LOADED or MISSING) - safe to cache and safe to write from
            return { profile, loadedSuccessfully: true }
        } catch (err) {
            console.error(
                `[SocialPoints][SERVER] Storage.player.get failed - this read is NOT cached and NOT safe to write from; the existing retry mechanisms (RESULT-tick rescan, pending-write retry) will attempt a fresh read: ${
                    err instanceof Error ? err.message : String(err)
                }`
            )
            // Deliberately NEVER socialPointsProfiles.set() here - see this function's
            // own doc comment.
            return { profile: emptySocialPointsProfile(), loadedSuccessfully: false }
        } finally {
            socialPointsLoadingInFlight.delete(address)
        }
    })()

    socialPointsLoadingInFlight.set(address, promise)
    return promise
}

async function saveSocialPointsProfile(address: string, profile: PersistedSocialPointsProfileV1): Promise<boolean> {
    try {
        const ok = await Storage.player.set(address, SOCIAL_POINTS_STORAGE_KEY, profile)
        if (!ok) {
            console.error('[SocialPoints][SERVER] Storage.player.set returned false - this event was not persisted, but gameplay is unaffected')
        }
        return ok
    } catch (err) {
        console.error(
            `[SocialPoints][SERVER] Storage.player.set threw - this event was not persisted, but gameplay is unaffected: ${
                err instanceof Error ? err.message : String(err)
            }`
        )
        return false
    }
}

/**
 * Applies one round's +1 validRound to a single player, as a queued
 * read-current -> build candidate -> commit-only-on-success transaction -
 * identical shape to applyDeltaToPlayer above, own domain. Runs inside the
 * SAME enqueueWrite queue Connections uses (not a second one), so a Social
 * Points write and a Connections write can never be in flight at the same
 * time. On failure, nothing about this player's state changes at all - not
 * validRounds, not recentProcessedEventIds - so the next RESULT tick's
 * rescan is free to retry this exact eventId from scratch.
 *
 * On a successful SAVE (and ONLY then - never on ALREADY_PROCESSED, never
 * before the player-scoped write itself has confirmed), schedules a
 * leaderboard mirror sync with the freshly-committed ABSOLUTE validRounds -
 * never a delta - so the scene-scoped index converges on the same truth
 * regardless of how many times or how out-of-order this ends up syncing.
 * Fire-and-forget: scheduleLeaderboardSync() never throws and its own
 * eventual Storage.set is a separate, later entry in the same shared queue -
 * never awaited here, so it can never block or fail this player's Social
 * Points result.
 */
async function applySocialPointsEvent(address: string, eventId: string, observedDisplayName: string | undefined): Promise<ApplyDeltaResult> {
    const { profile: baseline, loadedSuccessfully } = await loadSocialPointsProfile(address)
    if (!loadedSuccessfully) {
        // The Storage.player.get itself failed - `baseline` is a throwaway empty
        // profile, NOT a confirmed state. Abort without touching Storage or
        // socialPointsProfiles: never increment validRounds from this unreliable
        // baseline. The existing RESULT-tick rescan (scanCurrentRoundForSocialPoints)
        // calls this again on the next tick with a genuinely fresh read - a failed
        // load is never cached, so no separate retry bookkeeping is needed.
        return 'FAILED'
    }
    if (hasProcessedSocialPointsEventId(baseline, eventId)) {
        return 'ALREADY_PROCESSED' // fast path - never even joins the queue
    }

    return enqueueWrite(async (): Promise<ApplyDeltaResult> => {
        // Re-check against the CURRENT canonical profile, not `baseline` - mirrors
        // applyDeltaToPlayer's own reasoning: another queued write for this same
        // player (Social Points or Connections) may have already run its turn.
        const current = socialPointsProfiles.get(address) ?? baseline
        if (hasProcessedSocialPointsEventId(current, eventId)) {
            return 'ALREADY_PROCESSED'
        }

        const candidate: PersistedSocialPointsProfileV1 = {
            version: current.version,
            validRounds: current.validRounds + 1,
            friendshipBonusPoints: current.friendshipBonusPoints,
            awardedFriendshipBonuses: current.awardedFriendshipBonuses,
            recentProcessedEventIds: [...current.recentProcessedEventIds]
        }
        pushProcessedSocialPointsEventId(candidate, eventId)

        const ok = await saveSocialPointsProfile(address, candidate)
        if (!ok) {
            return 'FAILED'
        }

        socialPointsProfiles.set(address, candidate) // commit - only now does this become the canonical profile
        scheduleLeaderboardSync(address, candidate.validRounds, candidate.friendshipBonusPoints, observedDisplayName)
        return 'SAVED'
    })
}

/** One player's +1 validRound event for `roundId` - dedup, apply, and log-only-on-non-success, mirroring processRoundPair's own shape for a single subject instead of a pair. */
async function processSocialPointsEvent(roundId: number, address: string, observedDisplayName: string | undefined): Promise<void> {
    const eventId = `${SERVER_SESSION_ID}:${roundId}:${address}`
    if (processedSocialPointsEventsInMemory.has(eventId)) {
        return
    }

    try {
        const result = await applySocialPointsEvent(address, eventId, observedDisplayName)
        if (result === 'SAVED' || result === 'ALREADY_PROCESSED') {
            processedSocialPointsEventsInMemory.add(eventId)
        } else {
            console.error(`[SocialPoints][SERVER] ${address} (round ${roundId}) not persisted yet - will retry on a later RESULT tick`)
        }
    } catch (err) {
        console.error(`[SocialPoints][SERVER] Failed to process round ${roundId} for ${address}: ${err instanceof Error ? err.message : String(err)}`)
    }
}

/** This round's distinct valid answerers, deduped by userId - defensive only: each client has exactly one PlayerAnswer entity (see networkPlayerAnswer.ts), so a duplicate should never occur, but this never assumes it. */
function getValidRoundAnswerers(roundId: number): string[] {
    const userIds = new Set<string>()
    for (const answer of getAnswersForRound(roundId)) {
        if (answer.option === AnswerOption.NO_ANSWER) continue
        userIds.add(answer.userId)
    }
    return [...userIds]
}

/**
 * Scans the CURRENT round's live synced answers for Social Points - a flat
 * loop per PLAYER, deliberately not the pair loop scanCurrentRoundForValidPairs
 * uses (that function is untouched; this is a fully separate scan of the same
 * underlying data).
 *
 * +1 validRound is an INDIVIDUAL PARTICIPATION reward: a player gets it the
 * moment THEIR OWN answer for this round is A or B, regardless of what
 * anyone else in the round did or didn't answer. Previously this required at
 * least 2 valid answerers this round, which meant a player who answered
 * validly could still get nothing if their only partner went AFK/NO_ANSWER -
 * an explicit product decision to remove that penalty (see this change's own
 * report for the full rationale/examples). This never touches
 * scanCurrentRoundForValidPairs above, whose own pair-based Connections/
 * Friendship logic still inherently requires two valid answerers (a "pair"
 * can't exist with fewer) - a round with only one answerer still can never
 * become a valid Connection/Friendship interaction, exactly as before.
 * Re-scanning an already-applied round is a cheap no-op via the same
 * eventId/dedupe discipline as Connections.
 */
function scanCurrentRoundForSocialPoints(state: RoundStateValue): void {
    if (state.phase !== SharedPhase.RESULT) return

    const validAnswerers = getValidRoundAnswerers(state.roundId)

    for (const userId of validAnswerers) {
        // Resolved from the RAW (non-normalized) userId, before normalizeUserId -
        // same reasoning as scanCurrentRoundForValidPairs above: getPlayer() matches
        // against the real, case-preserved address, not the persistence-layer key.
        const observedDisplayName = resolveObservedDisplayName(userId)
        void processSocialPointsEvent(state.roundId, normalizeUserId(userId), observedDisplayName)
    }
}

// ---------------------------------------------------------------------------
// SOCIAL NOTIFICATIONS (unseen Connections badge) - a third fully independent
// domain from Connections/Social Points above, purely UI/notification
// metadata (socialQuestNotificationsV1). Own in-memory canonical map, own
// pending-retry lists - the only thing shared with the other two domains is
// the same global enqueueWrite queue, exactly like Social Points shares it
// with Connections.
//
// Unlike Connections/Social Points, a write here needs no eventId/dedupe
// log: "add otherUserId to my unseen set" and "remove these ids from my
// unseen set" are both naturally idempotent Set operations - applying either
// twice lands on the same final state as applying it once. That's what makes
// the simple pending-retry-list pattern below (mirroring
// pendingFriendshipReconciliations/retryPendingFriendshipBonuses) safe
// without any extra bookkeeping.
// ---------------------------------------------------------------------------

const notificationsProfiles = new Map<string, PersistedSocialNotificationsProfileV1>()
const notificationsLoadingInFlight = new Map<string, Promise<ProfileLoadOutcome<PersistedSocialNotificationsProfileV1>>>()

/**
 * Per-address tombstone for the mark-seen-before-add-unseen race: a
 * markConnectionsSeen for `otherUserId` can arrive and be processed BEFORE
 * this same pair's own addUnseenConnection write (triggered by the SAME
 * round's Connections SAVE) has landed - the two travel via completely
 * independent paths (a network message vs. this server's own RESULT-tick
 * scan) and enqueueWrite's single global FIFO only guarantees writes never
 * interleave/corrupt each other, NOT that one logically-earlier event's
 * write is enqueued before a logically-later one's. Without this, the
 * possible ordering [removeSeen(id) finds nothing to remove] -> [addUnseen(id)
 * adds it anyway] would resurrect a Connection the player already saw as
 * unseen again.
 *
 * Both addUnseenConnection and removeSeenConnections check/mutate this
 * Map INSIDE their own enqueueWrite callback, so whichever of the two
 * actually reaches the front of the global queue first for a given
 * (address, otherUserId) always completes its full check-and-mutate before
 * the other one starts - the two orderings below both converge on the
 * correct final state (otherUserId never ends up persisted as unseen):
 * - removeSeen runs first (id not yet in persisted unseen) -> tombstones it.
 *   addUnseen runs later -> sees the tombstone, does NOT add, consumes it.
 * - addUnseen runs first -> adds it normally. removeSeen runs later -> finds
 *   it and removes it normally. No tombstone ever created.
 *
 * Session-only, never persisted - same accepted residual limit as every
 * other pending-retry structure in this file (see retryPendingNotificationWrites'
 * own doc comment): if the server restarts before a tombstoned id's
 * addUnseenConnection ever arrives, the (unbounded-but-tiny-in-practice)
 * tombstone entry for it is simply lost with the rest of this process's
 * memory - no heavier mechanism than this is warranted for UI metadata.
 */
const seenBeforeUnseenWrite = new Map<string, Set<string>>()

function tombstoneSeenId(address: string, otherUserId: string): void {
    let set = seenBeforeUnseenWrite.get(address)
    if (!set) {
        set = new Set()
        seenBeforeUnseenWrite.set(address, set)
    }
    set.add(otherUserId)
}

/** True (and consumes the tombstone) if `otherUserId` was already marked seen for `address` before its own unseen-add could land - see seenBeforeUnseenWrite's own doc comment. */
function consumeSeenTombstone(address: string, otherUserId: string): boolean {
    const set = seenBeforeUnseenWrite.get(address)
    if (!set || !set.has(otherUserId)) return false
    set.delete(otherUserId)
    if (set.size === 0) seenBeforeUnseenWrite.delete(address)
    return true
}

/** Mirrors loadProfile/loadSocialPointsProfile's own LOADED/MISSING vs FAILED distinction and data-integrity invariant - notificationsProfiles is only ever populated from a confirmed read or a confirmed commit, never a failed read's catch branch. */
async function loadNotificationsProfile(address: string): Promise<ProfileLoadOutcome<PersistedSocialNotificationsProfileV1>> {
    const existing = notificationsProfiles.get(address)
    if (existing) return { profile: existing, loadedSuccessfully: true }

    const inFlight = notificationsLoadingInFlight.get(address)
    if (inFlight) return inFlight

    const promise = (async (): Promise<ProfileLoadOutcome<PersistedSocialNotificationsProfileV1>> => {
        try {
            const raw = await Storage.player.get<unknown>(address, SOCIAL_NOTIFICATIONS_STORAGE_KEY, { fresh: true })
            const profile = raw === null ? emptySocialNotificationsProfile() : sanitizeSocialNotificationsProfile(raw)
            notificationsProfiles.set(address, profile)
            return { profile, loadedSuccessfully: true }
        } catch (err) {
            console.error(
                `[Notifications][SERVER] Storage.player.get failed - this read is NOT cached and NOT safe to write from; a later retry attempts a fresh read: ${
                    err instanceof Error ? err.message : String(err)
                }`
            )
            return { profile: emptySocialNotificationsProfile(), loadedSuccessfully: false }
        } finally {
            notificationsLoadingInFlight.delete(address)
        }
    })()

    notificationsLoadingInFlight.set(address, promise)
    return promise
}

async function saveNotificationsProfile(address: string, profile: PersistedSocialNotificationsProfileV1): Promise<boolean> {
    try {
        const ok = await Storage.player.set(address, SOCIAL_NOTIFICATIONS_STORAGE_KEY, profile)
        if (!ok) {
            console.error('[Notifications][SERVER] Storage.player.set returned false - this notification metadata was not persisted, but Connections/gameplay are unaffected')
        }
        return ok
    } catch (err) {
        console.error(
            `[Notifications][SERVER] Storage.player.set threw - this notification metadata was not persisted, but Connections/gameplay are unaffected: ${
                err instanceof Error ? err.message : String(err)
            }`
        )
        return false
    }
}

/** One failed addUnseenConnection, queued for a later retry - see retryPendingNotificationWrites. */
interface PendingUnseenAdd {
    address: string
    otherUserId: string
}
/** One failed removeSeenConnections, queued for a later retry - carries the exact ids again (idempotent to replay, never a clear-all). */
interface PendingSeenRemoval {
    address: string
    connectionIds: string[]
}
const pendingUnseenAdds: PendingUnseenAdd[] = []
const pendingSeenRemovals: PendingSeenRemoval[] = []

/**
 * Adds `otherUserId` to `address`'s own persisted unseen list - called only
 * from processRoundPair, only on a fresh SAVED + isNew Connections delta
 * (see ApplyDeltaOutcome.isNew). Never called from hydration, reconciliation,
 * or a rescanned/existing partner - structurally, not by convention, since
 * this is the only call site.
 */
async function addUnseenConnection(address: string, otherUserId: string): Promise<void> {
    const { profile: baseline, loadedSuccessfully } = await loadNotificationsProfile(address)
    if (!loadedSuccessfully) {
        pendingUnseenAdds.push({ address, otherUserId })
        return
    }

    await enqueueWrite(async (): Promise<void> => {
        const current = notificationsProfiles.get(address) ?? baseline

        if (consumeSeenTombstone(address, otherUserId)) {
            // Already revealed and marked seen before this add could land (see
            // seenBeforeUnseenWrite's own doc comment) - never resurrect it as unseen.
            return
        }
        if (current.unseenConnectionIds.includes(otherUserId)) return // already there - idempotent no-op

        const candidate: PersistedSocialNotificationsProfileV1 = {
            version: current.version,
            unseenConnectionIds: [...current.unseenConnectionIds, otherUserId]
        }
        const ok = await saveNotificationsProfile(address, candidate)
        if (!ok) {
            pendingUnseenAdds.push({ address, otherUserId })
            return
        }
        notificationsProfiles.set(address, candidate) // commit - only now does this become the canonical profile
    })
}

/**
 * Removes exactly `ids` from `address`'s own persisted unseen list - an
 * exact diff (`persistedUnseen - ids`), NEVER a clear-all, so a Connection
 * added as unseen while this exact request is still in flight can never be
 * silently wiped. Called from the markConnectionsSeen message handler below.
 */
async function removeSeenConnections(address: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const { profile: baseline, loadedSuccessfully } = await loadNotificationsProfile(address)
    if (!loadedSuccessfully) {
        pendingSeenRemovals.push({ address, connectionIds: ids })
        return
    }

    await enqueueWrite(async (): Promise<void> => {
        const current = notificationsProfiles.get(address) ?? baseline
        const remaining = new Set(current.unseenConnectionIds)
        let changed = false

        for (const id of ids) {
            if (remaining.has(id)) {
                remaining.delete(id)
                changed = true
            } else {
                // Not (yet) in the persisted unseen list - its own addUnseenConnection
                // may still be in flight (see seenBeforeUnseenWrite's own doc comment).
                // Tombstone it so that add can never resurrect it once it does land.
                tombstoneSeenId(address, id)
            }
        }
        if (!changed) return // nothing to persist - exact diff, never writes a spurious no-op candidate

        const candidate: PersistedSocialNotificationsProfileV1 = {
            version: current.version,
            unseenConnectionIds: [...remaining]
        }
        const ok = await saveNotificationsProfile(address, candidate)
        if (!ok) {
            pendingSeenRemovals.push({ address, connectionIds: ids })
            return
        }
        notificationsProfiles.set(address, candidate) // commit - only now does this become the canonical profile
    })
}

/**
 * Retries every pending unseen-add/seen-removal, once per server tick - same
 * cadence and drain-before-retry shape as retryPendingFriendshipBonuses
 * above. Both operations are idempotent (see this section's own file-level
 * doc comment), so replaying one that already partially succeeded is always
 * safe.
 *
 * Explicit residual limit (documented, accepted - this is UI/notification
 * metadata, never gameplay): if this server process crashes or restarts
 * before a pending write here reaches Storage, that specific pending
 * notification is lost - the underlying Connection itself is entirely
 * unaffected, since it was already durably saved by its own separate,
 * already-committed Connections write. Unlike Friendship bonuses (which can
 * be recovered on a later reconnect via reconcileFriendshipBonuses, re-derived
 * from Connections' own persisted roundsTogether), there is no equivalent
 * source of truth to reconcile Notifications from after the fact - "was this
 * Connection ever new" is only knowable at the instant of its creation. This
 * is the same category of gap already accepted for pendingFriendshipReconciliations/
 * pendingLeaderboardSyncs (in-memory-only retry state), just without that
 * one's eventual reconciliation fallback.
 */
function retryPendingNotificationWrites(): void {
    if (pendingUnseenAdds.length > 0) {
        const adds = [...pendingUnseenAdds]
        pendingUnseenAdds.length = 0
        for (const { address, otherUserId } of adds) void addUnseenConnection(address, otherUserId)
    }
    if (pendingSeenRemovals.length > 0) {
        const removals = [...pendingSeenRemovals]
        pendingSeenRemovals.length = 0
        for (const { address, connectionIds } of removals) void removeSeenConnections(address, connectionIds)
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

    // Fire-and-forget: never blocks server boot, gameplay, or Social Points -
    // see hydrateLeaderboardCache()'s own doc comment. While this is still
    // running, scheduleLeaderboardSync() (called from real Social Points
    // saves that can happen during this same window) only buffers in memory.
    void hydrateLeaderboardCache()
    // Same reasoning, own separate index - see hydrateTopMatchesCache()'s own doc comment.
    void hydrateTopMatchesCache()
    // Same reasoning, own separate (per-week) index - see hydrateTopMatchesWeeklyCache()'s own doc comment.
    void hydrateTopMatchesWeeklyCache()

    persistenceRoom.onMessage('requestProfile', async (_data, context) => {
        if (!context) {
            console.log('[Persistence][SERVER] requestProfile received with no context - dropping')
            return
        }
        const address = normalizeUserId(context.from)
        try {
            // Reused for BOTH reconciliation sweeps below - this is the one
            // Storage.player.get for this address this handler ever performs; neither
            // sweep re-reads it. The client-facing response is unaffected by
            // loadedSuccessfully - it always gets `profile` (a genuinely empty one on
            // failure, exactly as before), preserving this handler's existing
            // tolerant-of-Storage-failure contract - only the internal reconciliation
            // decision (below) depends on whether the read was actually reliable.
            const { profile, loadedSuccessfully } = await loadProfile(address)
            // Own separate domain/read - a Storage.player.get failure here NEVER blocks
            // or delays the Connections response above (loadNotificationsProfile has its
            // own independent LOADED/MISSING vs FAILED handling); on failure this simply
            // sends an empty unseen list for now, exactly like every other tolerant-of-
            // Storage-failure response this handler already sends for Connections.
            const { profile: notificationsProfile } = await loadNotificationsProfile(address)
            persistenceRoom.send(
                'profileResponse',
                {
                    found: true,
                    dataJson: JSON.stringify(profile),
                    error: '',
                    serverSessionId: SERVER_SESSION_ID,
                    unseenConnectionIdsJson: JSON.stringify(notificationsProfile.unseenConnectionIds)
                },
                { to: [context.from] }
            )
            // Fire-and-forget - never delays or blocks the response above. See
            // reconcileFriendshipBonuses's own doc comment for why passing
            // loadedSuccessfully:false here makes it skip without marking anything
            // reconciled, instead of misreading an empty fallback as "no history".
            void reconcileFriendshipBonuses(address, profile, loadedSuccessfully)
            // Same reasoning, own separate domain - see reconcileTopMatchesForAddress's own doc comment.
            void reconcileTopMatchesForAddress(address, profile, loadedSuccessfully)
            // Own separate domain again (Social Points, not Connections) - see reconcileLeaderboardSnapshot's own doc comment.
            void reconcileLeaderboardSnapshot(address)
        } catch (err) {
            console.error(`[Persistence][SERVER] requestProfile handling failed: ${err instanceof Error ? err.message : String(err)}`)
            persistenceRoom.send(
                'profileResponse',
                { found: false, dataJson: '', error: 'load_failed', serverSessionId: SERVER_SESSION_ID, unseenConnectionIdsJson: '[]' },
                { to: [context.from] }
            )
        }
    })

    persistenceRoom.onMessage('markConnectionsSeen', async (data, context) => {
        if (!context) {
            console.log('[Notifications][SERVER] markConnectionsSeen received with no context - dropping')
            return
        }
        const address = normalizeUserId(context.from) // identity is ALWAYS derived from context.from, never a client-sent field
        try {
            const parsed: unknown = JSON.parse(data.connectionIdsJson)
            const ids = sanitizeConnectionIdList(parsed, MAX_MARK_SEEN_IDS_PER_REQUEST) // never trusts the payload directly - validated/normalized/deduped/capped here
            await removeSeenConnections(address, ids)
        } catch (err) {
            console.error(`[Notifications][SERVER] markConnectionsSeen handling failed for ${address}: ${err instanceof Error ? err.message : String(err)}`)
        }
    })

    if (serverTickIntervalId === null) {
        serverTickIntervalId = setInterval(() => {
            const state = getRoundState()
            // Unconditional - runs regardless of phase, so a roundId's weekKey is
            // captured the moment it first becomes ANSWERING, not only once RESULT
            // is reached. See captureRoundWeekKeyIfNeeded's own doc comment.
            captureRoundWeekKeyIfNeeded(state)
            scanCurrentRoundForValidPairs(state)
            scanCurrentRoundForSocialPoints(state)
            // All unconditional - NOT gated on RESULT phase like the two scans
            // above. A pending leaderboard mirror sync, Friendship bonus, or Top
            // Matches sync can still need retrying long after the RESULT that
            // produced it has ended; see each function's own doc comment.
            retryPendingLeaderboardSyncs()
            retryPendingFriendshipBonuses()
            retryPendingTopMatchSyncs()
            retryPendingNotificationWrites()
            // Detects a Monday 00:00 UTC rollover purely by comparing timestamps,
            // every tick - never depends on a server restart happening near the
            // boundary. See checkTopMatchesWeeklyRollover's own doc comment.
            checkTopMatchesWeeklyRollover()
        }, 1000)
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
                    differentAnswers: record.differentAnswers + (unconfirmed?.differentAnswers ?? 0),
                    // Carried through as-is - the unconfirmed local reconciliation above is
                    // purely about round/answer counters, it never observes or affects names.
                    lastKnownDisplayName: record.lastKnownDisplayName
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

            // Own separate domain, own separate parse - a failure here is caught by
            // the SAME catch block below, so a malformed unseenConnectionIdsJson can
            // never prevent the Connections hydration above (already applied by this
            // point) from taking effect. Seeds (merges into) socialNotificationsManager's
            // own live Set and flips it to READY - see hydrateUnseenConnections' own
            // doc comment for why this is always a merge, never a replace.
            const parsedUnseenIds: unknown = JSON.parse(data.unseenConnectionIdsJson)
            const unseenIds = Array.isArray(parsedUnseenIds) ? parsedUnseenIds.filter((id): id is string => typeof id === 'string') : []
            hydrateUnseenConnections(unseenIds)
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
