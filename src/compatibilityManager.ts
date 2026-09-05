// -----------------------------------------------------------------------
// COMPATIBILITY (Model B - accumulated) - pure derivation on top of
// connectionsManager.ts's existing sameAnswers/differentAnswers counters.
// No state, no networking, no persistence of its own: exactly one number is
// ever computed here, from data that already accumulates correctly across
// sessions (see connectionsManager.hydrateConnections /
// persistenceManager.ts). Same discipline as persistenceSchema.ts's
// getSocialPoints/getQuestProgress/friendshipManager's getFriendshipLevel -
// never store a value that can be recomputed from a smaller source of truth.
// -----------------------------------------------------------------------

/** sameAnswers + differentAnswers - every round where BOTH players answered A/B, regardless of whether they matched. NO_ANSWER rounds never reach either counter (see connectionsManager.processRoundState/persistenceManager.scanCurrentRoundForValidPairs), so no separate exclusion is needed here. */
export function getSharedValidAnswers(sameAnswers: number, differentAnswers: number): number {
    return sameAnswers + differentAnswers
}

/**
 * Percentage of shared valid answers that matched, or `null` if there are none
 * yet to compute a percentage from (never 0 - a 0% and "no data" are
 * different states, and callers need to tell them apart rather than render a
 * misleading "0% compatible" for a pair that has never actually answered
 * together).
 */
export function getCompatibility(sameAnswers: number, differentAnswers: number): number | null {
    const sharedValidAnswers = getSharedValidAnswers(sameAnswers, differentAnswers)
    if (sharedValidAnswers === 0) return null
    return (sameAnswers / sharedValidAnswers) * 100
}
