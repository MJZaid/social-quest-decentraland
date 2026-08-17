import { getCelebrationSnapshot, CELEBRATION_TICKS as NEW_CONNECTION_DISPLAY_TICKS } from './connectionCelebration'
import { getFriendshipCelebrationSnapshot, CELEBRATION_TICKS as FRIENDSHIP_DISPLAY_TICKS } from './friendshipCelebration'
import { FriendshipLevel } from './friendshipManager'

/**
 * Presentation duration per celebration type, in local ticks (~seconds, same 1s
 * cadence as roundManager.tick() - see tick() below). Imported directly from the
 * source modules' own CELEBRATION_TICKS constants (~4.5s requested/5 actual for
 * NEW CONNECTION, ~6s for FRIENDSHIP LEVEL UP) rather than duplicated here, so
 * the two can never drift out of sync. The queue's job is WHEN something is
 * shown, not HOW LONG - it reuses rather than redefines those numbers.
 */

export interface PresentedNewConnectionCelebration {
    type: 'NEW_CONNECTION'
    newUserIds: string[]
    totalBefore: number
    totalAfter: number
}

export interface PresentedFriendshipCelebration {
    type: 'FRIENDSHIP'
    userIds: string[]
    level: FriendshipLevel | null
    roundsTogether: number | null
}

export type PresentedSocialCelebration = PresentedNewConnectionCelebration | PresentedFriendshipCelebration

interface QueueItem {
    /** `${type}:${roundId}` - the stable round-aware identity this whole module is built around. Never names/timestamps. */
    key: string
    durationTicks: number
    data: PresentedSocialCelebration
}

/** FIFO. queue[0], if present, is the currently PRESENTED item - everything after it is waiting. */
const queue: QueueItem[] = []

/**
 * Every key ever captured into the queue, kept forever (never removed when an
 * item finishes presenting) - mirrors the "already started, never reopen" pattern
 * connectionCelebration.ts/friendshipCelebration.ts already use internally
 * (lastCelebrationStartedRoundId), just generalized to a set since the queue can
 * accumulate many distinct captured roundIds over a session instead of tracking
 * only the single most recent one.
 */
const everCapturedKeys = new Set<string>()

/**
 * Ticks remaining for queue[0]'s presentation. `null` means queue[0] (if any)
 * hasn't started its own countdown yet - the moment tick() finds this, it starts
 * the full configured duration right then, which is what guarantees a queued
 * item gets its FULL duration measured from when it actually becomes visible,
 * not from when it was captured.
 */
let ticksRemaining: number | null = null

/**
 * Looks for an already-queued item (visible or waiting) with this exact key and,
 * if found, replaces its data in place - this is how a late same-round partner
 * merge (source module refreshing its own snapshot for the same roundId) reaches
 * an item that's already sitting in the queue, whether it's the one currently on
 * screen or still waiting its turn. Never touches durationTicks/ticksRemaining,
 * so a merge can never reset or extend the presentation timer.
 */
function mergeIntoExisting(key: string, data: PresentedSocialCelebration): boolean {
    const existing = queue.find((item) => item.key === key)
    if (!existing) return false
    existing.data = data
    return true
}

function captureNewConnection(): void {
    const snapshot = getCelebrationSnapshot()
    if (snapshot === null) return

    const key = `NEW_CONNECTION:${snapshot.roundId}`
    const data: PresentedNewConnectionCelebration = {
        type: 'NEW_CONNECTION',
        newUserIds: snapshot.newUserIds,
        totalBefore: snapshot.totalBefore,
        totalAfter: snapshot.totalAfter
    }

    if (mergeIntoExisting(key, data)) return
    if (everCapturedKeys.has(key)) return // already shown and finished for this round - never reopen

    everCapturedKeys.add(key)
    queue.push({ key, durationTicks: NEW_CONNECTION_DISPLAY_TICKS, data })
}

function captureFriendship(): void {
    const snapshot = getFriendshipCelebrationSnapshot()
    if (snapshot === null) return

    const key = `FRIENDSHIP:${snapshot.roundId}`
    const data: PresentedFriendshipCelebration = {
        type: 'FRIENDSHIP',
        userIds: snapshot.userIds,
        level: snapshot.level,
        roundsTogether: snapshot.roundsTogether
    }

    if (mergeIntoExisting(key, data)) return
    if (everCapturedKeys.has(key)) return

    everCapturedKeys.add(key)
    queue.push({ key, durationTicks: FRIENDSHIP_DISPLAY_TICKS, data })
}

/**
 * Captures newly-discovered celebrations from both source modules into the local
 * FIFO, then advances the presentation timer for whichever item is currently
 * queue[0]. Called unconditionally from roundManager.tick() every ~1s, regardless
 * of round phase - the queue is deliberately NOT gated on RESULT/ANSWERING/WAITING
 * the way the source modules are: once something is captured here, presenting it
 * to completion is this module's job alone, so a queued item is never lost just
 * because the round moves on to a new question while it's still waiting its turn.
 *
 * Capture order (NEW CONNECTION before FRIENDSHIP) is what gives NEW CONNECTION
 * priority when both are discovered together with nothing currently queued - it's
 * simply appended to the empty queue first, then FRIENDSHIP right behind it,
 * which is plain FIFO from that point on - no special-casing needed beyond this
 * fixed check order.
 */
export function tick(): void {
    captureNewConnection()
    captureFriendship()

    while (queue.length > 0) {
        if (ticksRemaining === null) {
            // queue[0] just became the active item (either just captured into an empty
            // queue, or just promoted after the previous item finished) - its full
            // duration starts counting from this exact tick, never from capture time.
            ticksRemaining = queue[0].durationTicks
        }

        ticksRemaining -= 1
        if (ticksRemaining > 0) break // still presenting - nothing more to do this tick

        queue.shift()
        ticksRemaining = null
        // Loop continues: if another item is waiting, it starts its own full duration
        // immediately in this same tick - no dead gap where the slot shows nothing.
    }
}

/** The single celebration the UI should render right now, or null if none is queued. */
export function getPresentedCelebration(): PresentedSocialCelebration | null {
    return queue.length > 0 ? queue[0].data : null
}
