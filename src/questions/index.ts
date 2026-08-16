import { Question, QuestionCategory, QuestionIntensity } from './types'
import { ICEBREAKER_QUESTIONS } from './icebreaker'
import { PERSONALITY_QUESTIONS } from './personality'
import { LIFESTYLE_QUESTIONS } from './lifestyle'
import { FUNNY_QUESTIONS } from './funny'
import { FANTASY_QUESTIONS } from './fantasy'
import { DEEP_QUESTIONS } from './deep'
import { GAMING_QUESTIONS } from './gaming'
import { METAVERSE_QUESTIONS } from './metaverse'
import { CHAOS_QUESTIONS } from './chaos'

export { Question, QuestionCategory, QuestionIntensity } from './types'

/**
 * Explicit, fixed-order concatenation - never built by iterating object/category keys.
 * Every client ships this exact source, in this exact order, so QUESTIONS[i] refers to
 * the same question on every client without any coordination.
 */
export const QUESTIONS: Question[] = [
    ...ICEBREAKER_QUESTIONS,
    ...PERSONALITY_QUESTIONS,
    ...LIFESTYLE_QUESTIONS,
    ...FUNNY_QUESTIONS,
    ...FANTASY_QUESTIONS,
    ...DEEP_QUESTIONS,
    ...GAMING_QUESTIONS,
    ...METAVERSE_QUESTIONS,
    ...CHAOS_QUESTIONS
]

const VALID_CATEGORIES: ReadonlySet<QuestionCategory> = new Set([
    'ICEBREAKER',
    'PERSONALITY',
    'LIFESTYLE',
    'FUNNY',
    'FANTASY',
    'DEEP',
    'GAMING',
    'METAVERSE',
    'CHAOS'
])
const VALID_INTENSITIES: ReadonlySet<QuestionIntensity> = new Set([1, 2, 3])

/**
 * Fail-fast content integrity check, run once when this module initializes - not per
 * round/frame. Throws on the first problem found rather than logging, since a broken
 * question bank should stop the scene from starting in a bad state, not warn and continue.
 * Silent on success.
 */
function validateQuestionBank(questions: Question[]): void {
    const seenIds = new Set<string>()

    for (const q of questions) {
        if (!q.id) {
            throw new Error(`Invalid question bank: empty id on question "${q.question}"`)
        }
        if (seenIds.has(q.id)) {
            throw new Error(`Invalid question bank: duplicate id "${q.id}"`)
        }
        seenIds.add(q.id)

        if (!q.question) {
            throw new Error(`Invalid question bank: empty question text on id "${q.id}"`)
        }
        if (!q.optionA) {
            throw new Error(`Invalid question bank: empty optionA on id "${q.id}"`)
        }
        if (!q.optionB) {
            throw new Error(`Invalid question bank: empty optionB on id "${q.id}"`)
        }
        if (!VALID_CATEGORIES.has(q.category)) {
            throw new Error(`Invalid question bank: invalid category "${q.category}" on id "${q.id}"`)
        }
        if (!VALID_INTENSITIES.has(q.intensity)) {
            throw new Error(`Invalid question bank: invalid intensity "${q.intensity}" on id "${q.id}"`)
        }
    }
}

validateQuestionBank(QUESTIONS)

/** Deterministic PRNG (mulberry32) - same seed always produces the same sequence on every client. */
function seededRandom(seed: number): () => number {
    let state = seed | 0
    return () => {
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** Fisher-Yates shuffle driven by a seeded (not Math.random) generator, so it's reproducible. */
function seededShuffle<T>(array: T[], seed: number): T[] {
    const result = array.slice()
    const random = seededRandom(seed)
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[result[i], result[j]] = [result[j], result[i]]
    }
    return result
}

const cycleOrderCache = new Map<number, number[]>()

/**
 * Returns the shuffled order (as QUESTIONS indices) for a given cycle number.
 * Pure function of `cycleNumber` - every client computes the identical order
 * with no coordination needed. Guarantees the first question of a cycle never
 * matches the last question of the previous cycle, same as before, but derived
 * deterministically instead of re-rolling with Math.random.
 */
function getCycleOrder(cycleNumber: number): number[] {
    const cached = cycleOrderCache.get(cycleNumber)
    if (cached) return cached

    const indices = QUESTIONS.map((_, index) => index)
    const order = seededShuffle(indices, cycleNumber)

    if (cycleNumber > 0 && order.length > 1) {
        const previousOrder = getCycleOrder(cycleNumber - 1)
        const previousLast = previousOrder[previousOrder.length - 1]
        if (order[0] === previousLast) {
            // Deterministic alternate draw to pick the swap target - never Math.random.
            const altRandom = seededRandom(cycleNumber ^ 0x9e3779b9)
            const swapIndex = 1 + Math.floor(altRandom() * (order.length - 1))
            ;[order[0], order[swapIndex]] = [order[swapIndex], order[0]]
        }
    }

    cycleOrderCache.set(cycleNumber, order)
    return order
}

/**
 * Maps a 1-based `roundId` to a QUESTIONS index. Every question appears once per
 * cycle of QUESTIONS.length rounds, cycles reshuffle deterministically, and a
 * cycle's first question never matches the previous cycle's last question.
 */
export function getQuestionIndexForRound(roundId: number): number {
    const cycleLength = QUESTIONS.length
    const positionInCycle = (roundId - 1) % cycleLength
    const cycleNumber = Math.floor((roundId - 1) / cycleLength)
    return getCycleOrder(cycleNumber)[positionInCycle]
}
