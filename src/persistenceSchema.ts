/**
 * Data shape persisted via Storage.player for Social Quest's social progress.
 * Aggregated counters only - no question text, no chat, no per-round answer
 * history, no display names, no friendshipLevel (derived, never stored). Mirrors
 * connectionsManager.ts's session-only ConnectionRecord, minus otherUserId (that's
 * the Record key here) and lastProcessedRoundId (a session-local dedup marker that
 * has no meaning across sessions - see roundEventId in persistenceManager.ts for
 * the cross-session equivalent).
 */
export interface PersistedConnectionRecord {
    roundsTogether: number
    sameAnswers: number
    differentAnswers: number
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
            connections[normalizeUserId(userId)] = { roundsTogether, sameAnswers, differentAnswers }
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
