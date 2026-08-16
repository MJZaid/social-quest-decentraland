export type QuestionCategory =
    | 'ICEBREAKER'
    | 'PERSONALITY'
    | 'LIFESTYLE'
    | 'FUNNY'
    | 'FANTASY'
    | 'DEEP'
    | 'GAMING'
    | 'METAVERSE'
    | 'CHAOS'

/** Conversational intensity, not difficulty: 1 = casual icebreaker, 2 = reveals preference/personality, 3 = deeper but still socially safe. */
export type QuestionIntensity = 1 | 2 | 3

export interface Question {
    /** Stable content identity - independent of array position. Never synchronized over the network. */
    id: string
    category: QuestionCategory
    intensity: QuestionIntensity
    question: string
    optionA: string
    optionB: string
}
