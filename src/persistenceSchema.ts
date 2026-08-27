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
