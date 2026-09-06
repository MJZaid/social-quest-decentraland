import { executeTask } from '@dcl/sdk/ecs'

// -----------------------------------------------------------------------
// PROFILE PICTURE MANAGER - resolves a Decentraland user's real profile
// picture (catalyst `snapshots.face256`) by userId/address, purely as a
// URL lookup + in-memory cache. Deliberately isolated from
// connectionsManager.ts and every other Social Agenda data source: this
// file knows nothing about Connections, Affinity, Friendship, or rounds -
// it only ever answers "what is the current best-known face256 URL (or
// lack thereof) for this userId". If the catalyst profile shape or the
// snapshots field itself changes or is deprecated in the future, only this
// file needs to change.
//
// Validated end-to-end via a temporary, isolated preview test before this
// file existed (that scratch code has since been removed): GET
// https://peer.decentraland.org/lambdas/profile/<address> returns
// avatars[0].avatar.snapshots.face256 as a real, renderable HTTPS PNG URL,
// and that URL renders correctly via uiBackground.texture when paired with
// textureMode:'stretch' inside an overflow:'hidden' circular container
// (see ui.tsx's avatar medallion). Both the singular (/lambdas/profile)
// and plural (/lambdas/profiles) catalyst endpoints were confirmed to
// return the identical snapshots.face256 value for the same account -
// the singular endpoint is used here because Social Agenda only ever
// needs to resolve a handful of individually-revealed rows (capped at
// AGENDA_ROWS_PER_PAGE=6 visible at once) with results cached forever
// per session, not a bulk upfront fetch of every Connection - a batch
// POST to /lambdas/profiles would save nothing here and would add
// request-batching/aggregation complexity this use case doesn't need.
// -----------------------------------------------------------------------

const CATALYST_PROFILE_URL = 'https://peer.decentraland.org/lambdas/profile/'

type ProfilePictureState =
    | { status: 'loading' }
    | { status: 'ready'; url: string }
    | { status: 'missing' }
    | { status: 'failed' }

/**
 * Session-only, in-memory cache keyed by normalized (lowercased) userId.
 * Never written to Storage - a fresh scene load re-resolves everything,
 * which is fine since profile pictures rarely change and this is
 * explicitly not meant to track wearable changes mid-session (see this
 * module's own resolution-once policy above).
 */
const profilePictureCache = new Map<string, ProfilePictureState>()

function normalizeUserId(userId: string): string {
    return userId.toLowerCase()
}

/**
 * Kicks off resolution for this userId if (and only if) nothing is
 * already known about it - the cache entry itself is the dedup guard: it
 * is written synchronously to 'loading' BEFORE the first `await`, so a
 * second call for the same userId in the same or a later frame always
 * sees an existing entry and returns immediately without starting a
 * second concurrent request. Safe to call every frame/render - the
 * network request itself only ever happens once per userId per session.
 */
export function requestProfilePicture(userId: string): void {
    const key = normalizeUserId(userId)
    if (profilePictureCache.has(key)) return

    profilePictureCache.set(key, { status: 'loading' })

    executeTask(async () => {
        try {
            const res = await fetch(`${CATALYST_PROFILE_URL}${key}`)
            if (!res.ok) {
                console.error(`[ProfilePictureManager] Catalyst profile request for ${key} failed with status ${res.status}`)
                profilePictureCache.set(key, { status: 'failed' })
                return
            }

            const text = await res.text()
            const data = JSON.parse(text) as { avatars?: Array<{ avatar?: { snapshots?: { face256?: string } } }> }
            const face256 = data.avatars?.[0]?.avatar?.snapshots?.face256

            profilePictureCache.set(key, face256 ? { status: 'ready', url: face256 } : { status: 'missing' })
        } catch (err) {
            console.error(`[ProfilePictureManager] Failed to resolve profile picture for ${key}: ${err instanceof Error ? err.message : String(err)}`)
            profilePictureCache.set(key, { status: 'failed' })
        }
    })
}

/** The resolved face256 URL for this userId, or null if not ready yet (unknown/loading/missing/failed) - callers render a fallback in every null case, without needing to distinguish why. */
export function getProfilePictureUrl(userId: string): string | null {
    const state = profilePictureCache.get(normalizeUserId(userId))
    return state?.status === 'ready' ? state.url : null
}
