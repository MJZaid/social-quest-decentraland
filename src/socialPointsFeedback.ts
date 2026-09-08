import { engine } from '@dcl/sdk/ecs'
import { myProfile } from '@dcl/sdk/network'
import { SharedPhase, RoundStateValue } from './networkRoundState'
import { getAnswersForRound, AnswerOption } from './networkPlayerAnswer'
import { getNewConnectionsFromLastRound } from './connectionsManager'
import { getFriendshipLevelUpsFromLastTick, FRIENDSHIP_LEVELS, FriendshipLevel } from './friendshipManager'

// -----------------------------------------------------------------------
// SOCIAL POINTS FEEDBACK - client/UI-only optimistic reward detection and
// presentation queue for the HUD's "+1 SP" micro toast (VALID_ROUND).
// FRIENDSHIP_BONUS rewards are detected here too (see tickFriendshipBonus
// below) and still bump the HUD counter exactly the same way, but are
// deliberately NEVER queued for presentation - that bonus is shown inline
// inside NewConnectionToast/FriendshipToast (ui.tsx's existing social
// celebrations) instead of a separate toast, per explicit product decision.
// See queueReward's own doc comment for why.
//
// Mirrors the EXACT criteria persistenceManager.ts's own
// scanCurrentRoundForSocialPoints/crossedFriendshipMilestones already use,
// computed independently client-side from data already locally available -
// same "client optimistic, server authoritative" pattern already
// established by connectionCelebration.ts/friendshipCelebration.ts. Never
// touches Storage, never sends/receives a network message, never
// recalculates the Social Points formula (validRounds+friendshipBonusPoints
// stays exclusively persistenceManager.ts/persistenceSchema.ts's job) or
// Friendship level detection (stays exclusively friendshipManager.ts's job)
// - this module only reacts to signals those already produce.
// -----------------------------------------------------------------------

export type SocialPointsRewardReason = 'VALID_ROUND' | 'FRIENDSHIP_BONUS'

export interface SocialPointsReward {
    amount: number
    reason: SocialPointsRewardReason
    /** Only set for FRIENDSHIP_BONUS - the level whose milestone was just crossed. */
    milestone?: FriendshipLevel
}

/** Total duration (seconds) VALID_ROUND's micro toast stays visible, POP included - "MICRO ~1.3-1.5s" per the brief, picked at the midpoint. FRIENDSHIP_BONUS has no toast duration anymore - see queueReward's own doc comment for why. */
const MICRO_REWARD_DURATION_SECONDS = 1.4
/** POP phase length, seconds - short relative to the whole duration. */
const POP_PHASE_SECONDS = 0.15
/** Combined SLIDE UP + FADE exit phase length, seconds - the tail end of the total duration; both effects run together during this window (see getActiveSocialPointsReward's own doc comment). */
const EXIT_PHASE_SECONDS = 0.35

interface QueuedReward {
    reward: SocialPointsReward
    totalDurationSeconds: number
    elapsedSeconds: number
}

/** FIFO for TOAST PRESENTATION only - queue[0] (via activeQueueItem below) is what's currently shown, everything else waits its turn. Independent of whether the HUD counter's baseline is ready yet (see pendingCounterAmount below) - a toast can show even before the counter has a real number to add onto. */
const presentationQueue: QueuedReward[] = []

/**
 * Amounts detected AFTER the HUD counter's baseline was already confirmed
 * ready, not yet applied to it (ui.tsx's own `socialPointsCounter`). This is
 * the mechanism that lets ui.tsx apply a reward exactly once without this
 * module needing to know ui.tsx's own render timing: queueReward() below
 * only ever adds to this while `baselineReady` (see markSocialPointsBaselineReady)
 * is true. ui.tsx is the one place that decides WHEN it's safe to consume
 * (see consumePendingCounterAmount's own doc comment) - by construction that
 * is always AFTER baselineReady flipped true, so nothing here is ever
 * applied on top of a baseline that doesn't already account for it.
 *
 * Deliberately NOT used for pre-baseline rewards - see baselineReady's own
 * doc comment for why a reward detected before the baseline lands must
 * never be queued here at all (that was a real double-count bug: the
 * server-persisted total the baseline reads could already include it).
 */
let pendingCounterAmount = 0

/**
 * False until ui.tsx calls markSocialPointsBaselineReady(), exactly once,
 * the moment its own socialPointsCounter first gets a real number from
 * leaderboardNetwork's `me.socialPoints` (see ui.tsx's
 * requestSocialPointsBaseline). Gates whether a newly-detected reward is
 * queued for counter application (pendingCounterAmount) - NOT whether it is
 * queued for toast presentation (presentationQueue), which always happens
 * regardless of this flag.
 *
 * Why this split exists (the pre-baseline double-count fix): `me.socialPoints`
 * is computed server-side from the ALREADY-PERSISTED validRounds/
 * friendshipBonusPoints at the moment the leaderboard responds. A reward
 * detected client-side before that response lands may already be reflected
 * in the number the baseline is about to seed (the server usually persists
 * a delta fast, well within the ~7.5s baseline retry window) - queuing it
 * for counter application on top of that baseline would silently double it
 * (e.g. real persisted = 436, baseline = 436, if a pre-baseline +1 were
 * still queued the HUD would jump to 437). The first baseline is treated as
 * authoritative for everything that happened before it arrived - pre-baseline
 * rewards still show their toast (the delta really did just happen, worth
 * celebrating), they just never get added a second time once the counter
 * exists.
 *
 * Accepted residual, explicitly preferred over double-counting: if a reward
 * fired client-side right before the baseline landed but the server hadn't
 * actually finished persisting it yet when it computed `me.socialPoints`,
 * the HUD counter will read slightly LOW (missing that one delta) until the
 * next hydration/reload re-seeds it from Storage, which by then will
 * include it. This underscoring is intentionally tolerated - the
 * alternative (guaranteed double-counting on the much more common case of
 * the server already having persisted it) is worse.
 */
let baselineReady = false

export function markSocialPointsBaselineReady(): void {
    baselineReady = true
}

/**
 * Only VALID_ROUND ever enters `presentationQueue` - FRIENDSHIP_BONUS
 * deliberately never does. Product decision: that bonus is now shown inline
 * inside NewConnectionToast/FriendshipToast (ui.tsx's existing social
 * celebrations, resolved there from FRIENDSHIP_LEVELS), not a separate
 * toast. This isn't just "stop rendering it" - if a FRIENDSHIP_BONUS item
 * were still pushed here (even invisibly), it would occupy queue[0] for its
 * own duration, blocking a legitimate VALID_ROUND heart from showing during
 * that whole window. Skipping the push entirely avoids that.
 *
 * The counter-application half (pendingCounterAmount, gated on
 * baselineReady - see its own doc comment) is completely unaffected by this
 * split - both reward reasons still bump the counter exactly the same way,
 * exactly once, regardless of whether they ever show a toast of their own.
 */
function queueReward(reward: SocialPointsReward): void {
    if (reward.reason === 'VALID_ROUND') {
        presentationQueue.push({ reward, totalDurationSeconds: MICRO_REWARD_DURATION_SECONDS, elapsedSeconds: 0 })
    }
    if (baselineReady) {
        pendingCounterAmount += reward.amount
    }
    // else: pre-baseline reward - a VALID_ROUND toast still shows (see the push
    // above), but deliberately never queued for counter application - see
    // baselineReady's own doc comment for why.
}

// ---------------------------------------------------------------------------
// +1 SP PER VALID ROUND - mirrors persistenceManager.ts's
// scanCurrentRoundForSocialPoints EXACTLY: phase RESULT, NO_ANSWER excluded,
// INDIVIDUAL PARTICIPATION only (my own answer being A/B is the sole
// condition - what anyone else in the round answered, or didn't, never
// factors in). Computed from getAnswersForRound() - the same synced data
// connectionsManager.processRoundState() already reads, no new network
// dependency.
// ---------------------------------------------------------------------------

/** The last roundId a +1 SP reward was already queued for - a round is only ever rewarded once. */
let lastValidRoundRewardedRoundId: number | null = null

function tickValidRoundReward(state: RoundStateValue): void {
    if (state.phase !== SharedPhase.RESULT) return
    if (state.roundId === lastValidRoundRewardedRoundId) return

    const myAnswer = getAnswersForRound(state.roundId).find(
        (answer) => answer.userId === myProfile.userId && answer.option !== AnswerOption.NO_ANSWER
    )
    if (!myAnswer) return // I didn't answer validly this round - no Social Points for me, regardless of anyone else's answer

    lastValidRoundRewardedRoundId = state.roundId
    queueReward({ amount: 1, reason: 'VALID_ROUND' })
}

// ---------------------------------------------------------------------------
// FRIENDSHIP BONUS - reuses friendshipManager's own
// getFriendshipLevelUpsFromLastTick() verbatim, the same signal
// friendshipCelebration.ts already consumes - never recomputes Friendship
// level detection here. Resolves the bonus amount from the same
// FRIENDSHIP_LEVELS table persistenceManager.ts's own
// crossedFriendshipMilestones uses server-side, imported directly, never a
// second copy of the numbers.
//
// AUDIT (no code change to friendshipManager.ts, per explicit instruction):
// getFriendshipLevelUpsFromLastTick() is already exactly-once per crossing
// BY CONSTRUCTION - evaluateFriendshipLevels() updates its own
// acknowledgedLevels map to the new rank in the SAME call that detects the
// crossing (see friendshipManager.ts's own doc comment: "the acknowledged
// rank is updated immediately on detection, so no later tick can re-report
// the same crossing"), and lastTickEvents is reassigned to a fresh array
// every call - a tick with no NEW crossing returns an empty array, never a
// stale repeat of a previous one. Verified by reading that function's full
// body, not assumed. So there is no live bug today where the same crossing
// is re-emitted across multiple ticks.
//
// The dedup Set below is added anyway, as an explicit defensive backstop
// per direct instruction - it costs nothing, and means this file's own
// correctness never silently depends on friendshipManager.ts keeping that
// exact guarantee forever. Key is `friendship:<roundId>:<otherUserId>:<milestoneId>`
// - otherUserId is included even though the brief's own example key omitted
// it, because two DIFFERENT partners reaching the SAME milestone tier in the
// same round are two legitimately separate rewards (see "múltiples
// milestones legítimos... eventos separados") - a key without otherUserId
// would have incorrectly collapsed those into one.
// ---------------------------------------------------------------------------

/** Every "friendship:<roundId>:<otherUserId>:<milestoneId>" key ever queued this session - see this section's own AUDIT comment above for why this is a defensive backstop, not a fix for a confirmed live bug. Never cleared: a given (round, partner, milestone) combination can only ever legitimately occur once per session (roundsTogether never decreases), so this never grows meaningfully large. Shared by tickNewConnectionBonus below - same key format, same Set, one dedup mechanism for every milestone id including NEW_CONNECTION. */
const queuedFriendshipBonusKeys = new Set<string>()

/**
 * CONFIRMED GAP, now fixed: NEW_CONNECTION never appears in
 * getFriendshipLevelUpsFromLastTick() at all - friendshipManager.ts's own
 * evaluateFriendshipLevels() assigns it SILENTLY on first observation
 * (`acknowledged === undefined` branch), deliberately never pushing a
 * FriendshipLevelUpEvent for it (see that function's own doc comment: "the
 * very first shared round would always 'level up' to NEW CONNECTION,
 * duplicating the event the existing NEW CONNECTION celebration already
 * owns"). That means tickFriendshipBonus() below, which only reads that
 * function, could never queue NEW_CONNECTION's +25 for the counter - even
 * though the server DOES award it (crossedFriendshipMilestones(0, 1)
 * crosses NEW_CONNECTION's minRounds:1 on the very first commit) and
 * NewConnectionToast (ui.tsx) DOES show its bonus text. Without this
 * function, that toast text would have been cosmetic only - the HUD counter
 * would never actually have gained those points until the next hydration
 * silently caught it up from Storage.
 *
 * Fix: read connectionsManager's own getNewConnectionsFromLastRound()
 * directly - the SAME already-existing signal connectionCelebration.ts (and
 * therefore NewConnectionToast) is built from - as an independent THIRD
 * consumer, exactly like every other module already reading that function
 * (no change to connectionsManager.ts needed). Resolves the bonus from
 * FRIENDSHIP_LEVELS by the NEW_CONNECTION id, never hardcoded, and reuses
 * the SAME queuedFriendshipBonusKeys dedup Set as every other milestone -
 * no second/incompatible dedup mechanism.
 *
 * MUST only read getNewConnectionsFromLastRound() while state.phase ===
 * RESULT - confirmed by audit, not assumed: connectionsManager.processRoundState()
 * only clears/replaces newConnectionsThisRound INSIDE its own
 * `state.phase !== RESULT` early return, i.e. exclusively on a new round's
 * first RESULT tick. roundManager.ts's own startNewRound() advances
 * state.roundId the MOMENT the next round's ANSWERING begins (its own doc
 * comment: "roundId itself does NOT advance until COUNTDOWN finishes and
 * ANSWERING actually begins") - well before that round reaches its own
 * RESULT. Without this phase guard, a call during round B's own
 * COUNTDOWN/ANSWERING would see state.roundId already = B while
 * getNewConnectionsFromLastRound() still held round A's stale
 * otherUserId(s) (not yet cleared), building a NEW dedup key
 * (`friendship:B:...` instead of `friendship:A:...`) and re-queuing the
 * same +25 a second time. connectionCelebration.ts's own tick() already
 * avoids this exact trap via its own ANSWERING/non-RESULT early returns -
 * this mirrors that proven-safe pattern (same one tickValidRoundReward
 * above already uses).
 */
function tickNewConnectionBonus(state: RoundStateValue): void {
    if (state.phase !== SharedPhase.RESULT) return

    const definition = FRIENDSHIP_LEVELS.find((level) => level.id === 'NEW_CONNECTION')
    if (!definition) return // defensive only - NEW_CONNECTION always exists in the static table

    for (const otherUserId of getNewConnectionsFromLastRound()) {
        const key = `friendship:${state.roundId}:${otherUserId}:${definition.id}`
        if (queuedFriendshipBonusKeys.has(key)) continue
        queuedFriendshipBonusKeys.add(key)
        queueReward({ amount: definition.bonusPoints, reason: 'FRIENDSHIP_BONUS', milestone: definition.level })
    }
}

function tickFriendshipBonus(roundId: number): void {
    for (const event of getFriendshipLevelUpsFromLastTick()) {
        const definition = FRIENDSHIP_LEVELS.find((level) => level.level === event.newLevel)
        if (!definition) continue // defensive only - every real FriendshipLevel has a matching definition

        const key = `friendship:${roundId}:${event.otherUserId}:${definition.id}`
        if (queuedFriendshipBonusKeys.has(key)) continue
        queuedFriendshipBonusKeys.add(key)

        // Each milestone is its own reward event - deliberately never merged/fused
        // with another one from the same tick, even if several partners cross a
        // level simultaneously (see this file's own "no fusionarlos" instruction).
        queueReward({ amount: definition.bonusPoints, reason: 'FRIENDSHIP_BONUS', milestone: event.newLevel })
    }
}

/**
 * Called from roundManager.tick(), same cadence as
 * connectionCelebration.tick()/friendshipCelebration.tick()/
 * socialNotificationsManager.tick() - detects new rewards only. Does NOT
 * advance the presentation queue's own animation timing - that is driven by
 * real per-frame dt via the engine.addSystem registered in init() below,
 * never this 1s-cadence round tick.
 */
export function tick(state: RoundStateValue): void {
    tickValidRoundReward(state)
    tickNewConnectionBonus(state)
    tickFriendshipBonus(state.roundId)
}

// ---------------------------------------------------------------------------
// PRESENTATION - frame-based, driven by real dt via engine.addSystem, never
// the SDK's Tween component (confirmed incompatible with react-ecs UI - its
// Move/Rotate/Scale modes operate on Vector3/Quaternion, the 3D Transform
// component, with no bridge to UiTransform's Yoga-based layout) and never
// the 1s round-tick cadence above.
// ---------------------------------------------------------------------------

export type SocialPointsToastPhase = 'pop' | 'hold' | 'exit'

export interface ActiveSocialPointsReward {
    reward: SocialPointsReward
    phase: SocialPointsToastPhase
    /** 0-1 progress through the CURRENT phase only - callers (ui.tsx) combine this with `phase` to compute opacity/offset/scale themselves; kept presentation-agnostic here, same as every other snapshot-only getter in this file's sibling celebration modules. */
    phaseProgress: number
    /** Raw elapsed/total seconds for this reward's presentation, alongside phase/phaseProgress above - exposed so a reason-specific renderer (e.g. ui.tsx's VALID_ROUND "travel toward the counter" animation) can build its own custom timeline spanning MULTIPLE phases (here, everything after POP) without this module needing to know what that renderer wants to do with it. Still presentation-agnostic: no positions, colors, or curves are decided here. */
    elapsedSeconds: number
    totalDurationSeconds: number
}

let activeQueueItem: QueuedReward | null = null

function advancePresentationQueue(dt: number): void {
    if (activeQueueItem === null) {
        activeQueueItem = presentationQueue.shift() ?? null
        return
    }
    activeQueueItem.elapsedSeconds += dt
    if (activeQueueItem.elapsedSeconds >= activeQueueItem.totalDurationSeconds) {
        activeQueueItem = null // done - the next advance picks up whatever is queued next
    }
}

export function getActiveSocialPointsReward(): ActiveSocialPointsReward | null {
    if (activeQueueItem === null) return null
    const { reward, totalDurationSeconds, elapsedSeconds } = activeQueueItem

    if (elapsedSeconds < POP_PHASE_SECONDS) {
        return { reward, phase: 'pop', phaseProgress: elapsedSeconds / POP_PHASE_SECONDS, elapsedSeconds, totalDurationSeconds }
    }
    const exitStart = totalDurationSeconds - EXIT_PHASE_SECONDS
    if (elapsedSeconds >= exitStart) {
        return { reward, phase: 'exit', phaseProgress: (elapsedSeconds - exitStart) / EXIT_PHASE_SECONDS, elapsedSeconds, totalDurationSeconds }
    }
    const holdDuration = exitStart - POP_PHASE_SECONDS
    return {
        reward,
        phase: 'hold',
        phaseProgress: holdDuration > 0 ? (elapsedSeconds - POP_PHASE_SECONDS) / holdDuration : 1,
        elapsedSeconds,
        totalDurationSeconds
    }
}

// ---------------------------------------------------------------------------
// COUNTER POP - a separate, much shorter, self-contained animation for the
// HUD counter's own "pop" feedback (see ui.tsx's SocialPointsCounter).
// Triggered by ui.tsx itself, the moment it actually applies a reward
// amount to its own socialPointsCounter - never triggered from in here,
// since this module has no idea whether/when ui.tsx's baseline is ready to
// receive it.
// ---------------------------------------------------------------------------

const COUNTER_POP_DURATION_SECONDS = 0.3
/** Peak size multiplier, applied to width AND height together (never one alone) so the counter's aspect ratio is never deformed - see ui.tsx's SocialPointsCounter for how this is applied. */
const COUNTER_POP_PEAK_SCALE = 1.06
/** null = not currently popping. */
let counterPopElapsedSeconds: number | null = null

export function triggerSocialPointsCounterPop(): void {
    counterPopElapsedSeconds = 0
}

function advanceCounterPop(dt: number): void {
    if (counterPopElapsedSeconds === null) return
    counterPopElapsedSeconds += dt
    if (counterPopElapsedSeconds >= COUNTER_POP_DURATION_SECONDS) counterPopElapsedSeconds = null
}

/** 1 when not popping - a symmetric ramp up to COUNTER_POP_PEAK_SCALE at the midpoint and back down to 1, meant to be applied to BOTH width and height together. */
export function getSocialPointsCounterPopScale(): number {
    if (counterPopElapsedSeconds === null) return 1
    const progress = counterPopElapsedSeconds / COUNTER_POP_DURATION_SECONDS // 0-1
    const rampProgress = progress < 0.5 ? progress / 0.5 : 1 - (progress - 0.5) / 0.5 // 0 -> 1 -> 0
    return 1 + (COUNTER_POP_PEAK_SCALE - 1) * rampProgress
}

/**
 * Registers the single frame-driven system that advances both the
 * presentation queue's toast animation and the counter's own pop - call
 * once, from setupUi() (mirrors roundManager.start()/playerSessionManager.start()'s
 * own "explicit, one-time init call" pattern; nothing here auto-registers
 * on import).
 */
export function init(): void {
    engine.addSystem((dt: number) => {
        advancePresentationQueue(dt)
        advanceCounterPop(dt)
    })
}

/**
 * Returns and clears the total amount accumulated since the last call -
 * safe to call every frame (a no-op returning 0 when nothing is pending).
 * See pendingCounterAmount's own doc comment for the full contract this is
 * one half of - the other half is ui.tsx only ever calling this once its
 * own socialPointsCounter baseline is non-null.
 */
export function consumePendingCounterAmount(): number {
    const amount = pendingCounterAmount
    pendingCounterAmount = 0
    return amount
}
