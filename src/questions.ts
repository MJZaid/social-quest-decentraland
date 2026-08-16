export interface Question {
    question: string
    optionA: string
    optionB: string
}

export const QUESTIONS: Question[] = [
    { question: 'Would you rather live on the Moon or under the Ocean?', optionA: 'MOON', optionB: 'OCEAN' },
    { question: 'Would you rather have Cats or Dogs?', optionA: 'CATS', optionB: 'DOGS' },
    { question: 'Would you rather spend the day at the Beach or in the Mountains?', optionA: 'BEACH', optionB: 'MOUNTAINS' },
    { question: 'Would you rather have Summer or Winter all year?', optionA: 'SUMMER', optionB: 'WINTER' },
    { question: 'Would you rather travel to the Past or the Future?', optionA: 'PAST', optionB: 'FUTURE' },
    { question: 'Would you rather live in the City or the Countryside?', optionA: 'CITY', optionB: 'COUNTRYSIDE' },
    { question: 'Would you rather drink Coffee or Tea?', optionA: 'COFFEE', optionB: 'TEA' },
    { question: 'Would you rather spend your free time watching Movies or playing Games?', optionA: 'MOVIES', optionB: 'GAMES' },
    { question: 'Would you rather eat something Sweet or Salty?', optionA: 'SWEET', optionB: 'SALTY' },
    { question: 'Would you rather watch the Sunrise or the Sunset?', optionA: 'SUNRISE', optionB: 'SUNSET' }
]

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
