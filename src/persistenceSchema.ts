/**
 * Data shape persisted via Storage.player for Social Quest's social progress.
 * Aggregated counters, plus (as of this optional field) the best display name
 * the AUTHORITATIVE SERVER has itself observed for this partner - no question
 * text, no chat, no per-round answer history, no friendshipLevel (derived,
 * never stored). Mirrors connectionsManager.ts's session-only ConnectionRecord,
 * minus otherUserId (that's the Record key here) and lastProcessedRoundId (a
 * session-local dedup marker that has no meaning across sessions - see
 * roundEventId in persistenceManager.ts for the cross-session equivalent).
 */
export interface PersistedConnectionRecord {
    roundsTogether: number
    sameAnswers: number
    differentAnswers: number
    /**
     * Best display name the authoritative server has itself observed for this
     * partner via getPlayer()/ECS avatar state (see persistenceManager.ts's
     * scanCurrentRoundForValidPairs) - NEVER a client-claimed value, since
     * nothing the client sends to the server (RoundState/PlayerAnswer) carries
     * a name at all. Absent until the server has observed this partner at
     * least once. Only ever validated non-empty strings reach here (see
     * sanitizeDisplayName) - an old V1 profile predating this field simply
     * omits it, which is a perfectly valid state, not an error.
     */
    lastKnownDisplayName?: string
}

export interface PersistedSocialQuestProfileV1 {
    version: 1
    connections: Record<string, PersistedConnectionRecord>
    /** Bounded circular buffer of already-applied roundEventIds - see persistenceManager.ts. Never a full history log. */
    recentProcessedEventIds: string[]
}

export const PERSISTENCE_SCHEMA_VERSION = 1
export const STORAGE_KEY = 'socialQuestSocialProfileV1'
/** Keeps Storage bounded - large enough to absorb realistic reconnect/retry replay windows, small enough to never grow unbounded. */
export const MAX_RECENT_EVENT_IDS = 100
/** Defensive cap on partner deltas in a single round report - a real round never has anywhere near this many active players. */
export const MAX_DELTAS_PER_ROUND = 32

export function emptyProfile(): PersistedSocialQuestProfileV1 {
    return { version: PERSISTENCE_SCHEMA_VERSION, connections: {}, recentProcessedEventIds: [] }
}

/** Wallet addresses/userIds are case-insensitive - every persistence-layer read/write goes through this so a mixed-case caller can never split into two different records. */
export function normalizeUserId(userId: string): string {
    return userId.trim().toLowerCase()
}

/**
 * Order-independent pair key so `roundId:A,B` and `roundId:B,A` always mean
 * the same event. Shared by both server (persisting a pair's outcome) and
 * client (reconstructing the same event id to check whether a locally-known
 * round is already reflected in a just-loaded persisted snapshot - see
 * persistenceManager.ts's hydration-race handling) - must stay byte-identical
 * on both sides, hence living here rather than being duplicated.
 */
export function sortedPairKey(a: string, b: string): string {
    return [a, b].sort().join(',')
}

function isFiniteNonNegativeInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

/**
 * The single validation gate a display name must pass before it's trusted as
 * `lastKnownDisplayName` anywhere (loaded from Storage on the server, or just
 * observed live via getPlayer() before being stored) - a non-empty string
 * after trim(), else undefined. Never accepts whitespace-only or empty
 * strings, and deliberately never substitutes an artificial fallback (e.g.
 * "Player") here - callers that need a fallback apply their own (QUESTMATE_FALLBACK
 * in the UI), keeping "no valid name observed yet" and "resolved to a fallback
 * string" distinguishable all the way through this pipeline.
 */
export function sanitizeDisplayName(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Defensively validates/repairs a value loaded from Storage.player before anything
 * else touches it. Never throws - unrecognized shape, wrong version, or corrupted
 * fields are all treated as "no data", never as a crash or as data silently
 * propagating unchecked into gameplay-facing code (see connectionsManager.hydrateConnections).
 */
export function sanitizeProfile(raw: unknown): PersistedSocialQuestProfileV1 {
    if (!raw || typeof raw !== 'object') return emptyProfile()
    const value = raw as Record<string, unknown>
    if (value.version !== PERSISTENCE_SCHEMA_VERSION) return emptyProfile()

    const connections: Record<string, PersistedConnectionRecord> = {}
    if (value.connections && typeof value.connections === 'object') {
        for (const [userId, entry] of Object.entries(value.connections as Record<string, unknown>)) {
            if (typeof userId !== 'string' || userId.length === 0) continue
            if (!entry || typeof entry !== 'object') continue
            const record = entry as Record<string, unknown>
            const roundsTogether = record.roundsTogether
            const sameAnswers = record.sameAnswers
            const differentAnswers = record.differentAnswers
            if (!isFiniteNonNegativeInt(roundsTogether)) continue
            if (!isFiniteNonNegativeInt(sameAnswers)) continue
            if (!isFiniteNonNegativeInt(differentAnswers)) continue
            // Absent/invalid (including a pre-existing V1 profile that predates this
            // field entirely) sanitizes to undefined - a perfectly valid state, never
            // treated as corruption and never blocking the rest of this record.
            const lastKnownDisplayName = sanitizeDisplayName(record.lastKnownDisplayName)
            connections[normalizeUserId(userId)] = { roundsTogether, sameAnswers, differentAnswers, lastKnownDisplayName }
        }
    }

    let recentProcessedEventIds: string[] = []
    if (Array.isArray(value.recentProcessedEventIds)) {
        recentProcessedEventIds = value.recentProcessedEventIds.filter((id): id is string => typeof id === 'string').slice(-MAX_RECENT_EVENT_IDS)
    }

    return { version: PERSISTENCE_SCHEMA_VERSION, connections, recentProcessedEventIds }
}

/** Appends an event id, keeping the buffer bounded - a circular window via slice, never a full unbounded log. */
export function pushProcessedEventId(profile: PersistedSocialQuestProfileV1, eventId: string): void {
    profile.recentProcessedEventIds.push(eventId)
    if (profile.recentProcessedEventIds.length > MAX_RECENT_EVENT_IDS) {
        profile.recentProcessedEventIds = profile.recentProcessedEventIds.slice(-MAX_RECENT_EVENT_IDS)
    }
}

export function hasProcessedEventId(profile: PersistedSocialQuestProfileV1, eventId: string): boolean {
    return profile.recentProcessedEventIds.includes(eventId)
}

// -----------------------------------------------------------------------
// SOCIAL POINTS (Phase 1) - a fully independent persisted domain from the
// Connections profile above. Separate Storage key, separate schema, separate
// dedupe list - by design, so neither can ever affect or corrupt the other.
// The only thing the two domains share is the write queue (persistenceManager.ts),
// not any data shape here.
// -----------------------------------------------------------------------

/**
 * Data shape persisted via Storage.player for Social Quest's Social Points
 * progress. Deliberately minimal: a single counter of valid rounds and its
 * own dedupe list. socialPoints and questProgress are NEVER stored - both
 * are pure derivations of validRounds (see getSocialPointsSnapshot below),
 * so there is exactly one number that can ever be wrong, not three that
 * could drift apart from each other.
 */
export interface PersistedSocialPointsProfileV1 {
    version: 1
    validRounds: number
    /** Bounded circular buffer of already-applied per-player roundEventIds - see persistenceManager.ts. Never a full history log, and never the same list Connections uses. */
    recentProcessedEventIds: string[]
}

export const SOCIAL_POINTS_SCHEMA_VERSION = 1
export const SOCIAL_POINTS_STORAGE_KEY = 'socialQuestPointsProfileV1'
/** Same bound as Connections' own MAX_RECENT_EVENT_IDS, kept as an independent constant on purpose - the two domains' lists are unrelated and shouldn't share a knob just because the number happens to match today. */
export const MAX_RECENT_SOCIAL_POINTS_EVENT_IDS = 100

export function emptySocialPointsProfile(): PersistedSocialPointsProfileV1 {
    return { version: SOCIAL_POINTS_SCHEMA_VERSION, validRounds: 0, recentProcessedEventIds: [] }
}

/**
 * Defensively validates/repairs a value loaded from Storage.player before anything
 * else touches it - same discipline as sanitizeProfile above, kept fully separate.
 * Never throws; any unrecognized shape, wrong version, or corrupted field falls
 * back to emptySocialPointsProfile(), never a crash and never unchecked data
 * reaching gameplay-facing code.
 */
export function sanitizeSocialPointsProfile(raw: unknown): PersistedSocialPointsProfileV1 {
    if (!raw || typeof raw !== 'object') return emptySocialPointsProfile()
    const value = raw as Record<string, unknown>
    if (value.version !== SOCIAL_POINTS_SCHEMA_VERSION) return emptySocialPointsProfile()

    const validRounds = isFiniteNonNegativeInt(value.validRounds) ? value.validRounds : 0

    let recentProcessedEventIds: string[] = []
    if (Array.isArray(value.recentProcessedEventIds)) {
        recentProcessedEventIds = value.recentProcessedEventIds
            .filter((id): id is string => typeof id === 'string')
            .slice(-MAX_RECENT_SOCIAL_POINTS_EVENT_IDS)
    }

    return { version: SOCIAL_POINTS_SCHEMA_VERSION, validRounds, recentProcessedEventIds }
}

/** Appends an event id, keeping the buffer bounded - a circular window via slice, never a full unbounded log. Own list, own function - never Connections' pushProcessedEventId. */
export function pushProcessedSocialPointsEventId(profile: PersistedSocialPointsProfileV1, eventId: string): void {
    profile.recentProcessedEventIds.push(eventId)
    if (profile.recentProcessedEventIds.length > MAX_RECENT_SOCIAL_POINTS_EVENT_IDS) {
        profile.recentProcessedEventIds = profile.recentProcessedEventIds.slice(-MAX_RECENT_SOCIAL_POINTS_EVENT_IDS)
    }
}

export function hasProcessedSocialPointsEventId(profile: PersistedSocialPointsProfileV1, eventId: string): boolean {
    return profile.recentProcessedEventIds.includes(eventId)
}

/** Pure, UI-facing snapshot derived from validRounds alone - never persisted itself, so leaderboard/UI code (later phases) always reads the same single definition of these numbers. */
export interface SocialPointsSnapshot {
    validRounds: number
    socialPoints: number
    questProgress: number
}

/** How many validRounds make up one Social Points tier, and how many points that tier is worth - see getSocialPoints/getQuestProgress. */
const VALID_ROUNDS_PER_TIER = 5
const SOCIAL_POINTS_PER_TIER = 100

/** floor(validRounds / 5) * 100 - the only place this formula is written. */
export function getSocialPoints(validRounds: number): number {
    return Math.floor(validRounds / VALID_ROUNDS_PER_TIER) * SOCIAL_POINTS_PER_TIER
}

/** validRounds % 5 - progress toward the next tier. */
export function getQuestProgress(validRounds: number): number {
    return validRounds % VALID_ROUNDS_PER_TIER
}

export function getSocialPointsSnapshot(validRounds: number): SocialPointsSnapshot {
    return { validRounds, socialPoints: getSocialPoints(validRounds), questProgress: getQuestProgress(validRounds) }
}
