import ReactEcs, { Button, Label, ReactEcsRenderer, ScreenInsetArea, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { engine, timers, UiCanvasInformation } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { roundManager, RevealData, RevealEntry } from './roundManager'
import { playerSessionManager } from './playerSessionManager'
import { MIN_PLAYERS_REQUIRED } from './playerManager'
import { getDisplayNameFor, getAllConnections } from './connectionsManager'
import {
    getUnseenConnectionCount,
    getUnseenConnectionIds,
    removeSeenIdsLocally,
    drainPendingReveal,
    isNotificationsHydrated,
    requestMarkConnectionsSeen
} from './socialNotificationsManager'
import { getFriendshipLevel, FRIENDSHIP_LEVELS } from './friendshipManager'
import { getCompatibility, getSharedValidAnswers } from './compatibilityManager'
import {
    getPresentedCelebration,
    PresentedNewConnectionCelebration,
    PresentedFriendshipCelebration
} from './socialCelebrationQueue'
import { LeaderboardButton, LeaderboardPanel, isLeaderboardOpen, closeLeaderboard } from './leaderboardUi'
import { requestLeaderboard, getLatestLeaderboardResponse } from './leaderboardNetwork'
import {
    init as initSocialPointsFeedback,
    markSocialPointsBaselineReady,
    getActiveSocialPointsReward,
    consumePendingCounterAmount,
    triggerSocialPointsCounterPop,
    getSocialPointsCounterPopScale,
    ActiveSocialPointsReward
} from './socialPointsFeedback'
import { requestProfilePicture, getProfilePictureUrl } from './profilePictureManager'

/** Virtual design resolution this scene's UI is authored against - kept in sync with the setUiRenderer call below. */
const VIRTUAL_WIDTH = 1920
const VIRTUAL_HEIGHT = 1080

export function setupUi() {
    roundManager.start()
    playerSessionManager.start()
    ReactEcsRenderer.setUiRenderer(uiMenu, { virtualWidth: VIRTUAL_WIDTH, virtualHeight: VIRTUAL_HEIGHT })
    requestSocialPointsBaseline()
    initSocialPointsFeedback()
}

/**
 * The HUD counter's own local total - sourced EXCLUSIVELY from
 * leaderboardNetwork's existing `me.socialPoints` (itself
 * getTotalSocialPoints(validRounds, friendshipBonusPoints), computed
 * server-side - see persistenceSchema.ts/leaderboardRanking.ts). Never
 * derived from Connections, never a second copy of that formula.
 *
 * `null` means "no reliable baseline yet this session" - the counter
 * renders a placeholder (see SocialPointsCounter) rather than a possibly-
 * wrong 0. Once set to a real number by requestSocialPointsBaseline() below,
 * it is NEVER reseeded from a later leaderboardResponse (e.g. the player
 * manually opening the Leaderboard panel later, which calls its own
 * requestLeaderboard() and refreshes getLatestLeaderboardResponse()) - by
 * design, per explicit instruction: this session's own optimistic reward
 * increments (a later phase, not yet implemented) are meant to be the only
 * thing that changes this number after the initial seed. A fresh baseline
 * only ever comes from a new session's own call to this same function.
 */
let socialPointsCounter: number | null = null

/** Bounded retry count/spacing for the initial baseline fetch - "a reasonable, non-infinite retry", not a persistent poll. 5 attempts x 1.5s = ~7.5s of trying before giving up for the rest of this session; if the player opens the Leaderboard panel manually after that, its own requestLeaderboard() call will still populate getLatestLeaderboardResponse(), but nothing automatically re-checks it afterward - see socialPointsCounter's own "never reseed" doc comment for why that's intentional, not an oversight. */
const SOCIAL_POINTS_BASELINE_MAX_ATTEMPTS = 5
const SOCIAL_POINTS_BASELINE_RETRY_INTERVAL_MS = 1500

/**
 * Requests the leaderboard once, purely to read `me.socialPoints` for the
 * HUD counter's baseline - the Top N it also returns is unused here (see
 * leaderboardNetwork.ts's own LeaderboardResponse shape; reusing this
 * existing request/response avoids inventing a second, narrower message for
 * the same data). Mirrors persistenceManager.ts's own tickPersistenceLoad
 * pattern: request once, tolerate not being ready yet, never block anything
 * else. `me === null` while `status === 'ready'` is a genuine, valid "0
 * points, never yet reconciled onto the leaderboard mirror" case (see
 * reconcileLeaderboardSnapshot's own doc comment in persistenceManager.ts) -
 * NOT a sign to keep retrying, so it seeds 0 immediately, same as any other
 * confirmed value.
 */
function requestSocialPointsBaseline(attemptsLeft: number = SOCIAL_POINTS_BASELINE_MAX_ATTEMPTS): void {
    requestLeaderboard()
    timers.setTimeout(() => {
        if (socialPointsCounter !== null) return // already seeded (e.g. the player opened Leaderboard manually while this was waiting) - never reseed
        const response = getLatestLeaderboardResponse()
        if (response?.status === 'ready') {
            socialPointsCounter = response.me?.socialPoints ?? 0
            // Marks the baseline authoritative for everything that happened before
            // this exact moment - see socialPointsFeedback.ts's own baselineReady doc
            // comment for why a reward detected before this point must never be
            // queued for counter application (it may already be reflected in the
            // number just seeded above), while a reward detected AFTER this point
            // always is.
            markSocialPointsBaselineReady()
            return
        }
        if (attemptsLeft > 1) {
            requestSocialPointsBaseline(attemptsLeft - 1)
        }
        // else: exhausted the bounded retry budget - stays null/placeholder for the rest of
        // this session unless the player happens to open Leaderboard themselves later (which
        // does NOT automatically feed back into socialPointsCounter - see its own doc comment).
    }, SOCIAL_POINTS_BASELINE_RETRY_INTERVAL_MS)
}

const COLUMN_CENTERED = {
    width: '100%' as const,
    flexDirection: 'column' as const,
    alignItems: 'center' as const
}

const MUTED = Color4.create(0.7, 0.7, 0.75, 1)
const PANEL_BACKGROUND = Color4.create(0.05, 0.05, 0.1, 0.85)
/** Never used as an identity - purely a friendly presentation fallback when a name can't be resolved. */
const QUESTMATE_FALLBACK = 'Questmate'

/**
 * Social Agenda's own copies of the Leaderboard redesign's palette - same
 * exact values as leaderboardUi.tsx's CREAM/SOCIAL_PINK/TEAL_ACCENT,
 * deliberately duplicated rather than imported. leaderboardUi.tsx already
 * documents why: this file already depends on that one (LeaderboardButton/
 * LeaderboardPanel), so importing colors back the other way would create a
 * dependency between the two panels for a purely cosmetic reason - "sibling
 * panels, same visual language" is achieved by matching values, not sharing
 * a module. Used only by the Social Agenda block below - every other panel
 * in this file (gameplay, JOIN, celebrations, the still-unstyled HUD icons)
 * keeps its own existing colors untouched.
 */
const AGENDA_CREAM = Color4.create(0.97, 0.93, 0.86, 1)
const AGENDA_PINK = Color4.create(1, 0.75, 0.9, 1)
const AGENDA_TEAL = Color4.create(0.4, 0.75, 1, 1)

/** Whether the Social Agenda ("VIEW ALL CONNECTIONS") overlay is open - presentation-only, local, never synced. Default: closed. */
let socialAgendaOpen = false
/** Current 0-based Agenda page - reset to 0 every time the Agenda is opened, so a re-open never resumes on a stale page. */
let socialAgendaPage = 0

/**
 * Which Connections this CURRENT Agenda opening has revealed - drives both
 * the REVEAL banner and each row's "NEW" tag (see SocialAgenda/its row map).
 * Scoped to a single opening on purpose: reset to [] the moment Agenda
 * closes (see the per-frame check in uiMenu below), so a reopen never shows
 * a stale banner or stale NEW tags for Connections already revealed earlier.
 * Always appended to via revealUnseenConnections() below, NEVER reset to a
 * fresh snapshot mid-opening - a live Connection arriving while Agenda is
 * already open must ADD to this, not replace it.
 */
let agendaRevealedConnectionIds: string[] = []
/** Edge-detect guard for "Notifications hydration arrived while Agenda was already open" (see uiMenu's per-frame check) - a single boolean compare, not a poll/diff of any array. Reset alongside agendaRevealedConnectionIds whenever Agenda closes, so the next opening re-checks cleanly. */
let notificationsHydratedSeenLocally = false

/**
 * The one shared flow behind every case that reveals unseen Connections
 * inside the CURRENT Agenda opening: opening Agenda itself (with
 * Notifications already hydrated), Notifications hydration landing while
 * Agenda is already open, and a live new Connection arriving while Agenda is
 * already open (see uiMenu's per-frame check and SocialAgendaButton's
 * onMouseDown). Always additive to agendaRevealedConnectionIds, always the
 * exact ids given - never a clear-all, mirroring the server's own exact-diff
 * contract for removeSeenConnections.
 *
 * Idempotent by normalized (trim+lowercase) userId - REQUIRED because the
 * three call sites above are not mutually exclusive about which ids they can
 * carry. Concretely: a live Connection created while Agenda is CLOSED gets
 * queued into socialNotificationsManager's own pendingReveal (drained only
 * while Agenda is open - see uiMenu's per-frame check), but ALSO already sits
 * in getUnseenConnectionIds()'s own Set at that point - so the very next
 * Agenda open both (a) snapshots it via getUnseenConnectionIds() in
 * SocialAgendaButton's onMouseDown AND (b) drains the same still-pending id
 * out of pendingReveal on that same opening's first per-frame tick. Without
 * this dedup, that one Connection would be revealed/mark-seen-requested
 * twice, appearing as a duplicate name in the banner. Deduping here (once,
 * centrally) protects every current and future double-signal case without
 * either call site or socialNotificationsManager needing to know about
 * socialAgendaOpen or about each other.
 */
function revealUnseenConnections(ids: string[]): void {
    const alreadyRevealed = new Set(agendaRevealedConnectionIds)
    const newIds = [...new Set(ids.map((id) => id.trim().toLowerCase()))].filter((id) => !alreadyRevealed.has(id))
    if (newIds.length === 0) return

    agendaRevealedConnectionIds = [...agendaRevealedConnectionIds, ...newIds]
    removeSeenIdsLocally(newIds)
    requestMarkConnectionsSeen(newIds)
}

/** Hover/pressed visual state for SocialAgendaButton only - presentation-only, never affects the open/close logic itself. See AGENDA_BUTTON_ICON_SIZE_* constants' own doc comment for how these combine with the open state into one of three icon sizes (idle/hover-or-active/pressed). */
let socialAgendaButtonHovered = false
let socialAgendaButtonPressed = false

/**
 * Below this render scale, panels declared at their normal size (the 280-wide HUD
 * panel) stop being comfortably legible/tappable, so the expanded HUD switches to
 * its narrower COMPACT width. Celebrations always use the compact toast now,
 * regardless of this breakpoint. 0.65 comes from wanting a 280-declared-unit
 * panel to still render at roughly >=180 real canvas px wide
 * (180/280 ~= 0.65) - derived from our own panel sizes, not a guessed window width.
 */
const WIDE_MIN_SCALE = 0.65

/**
 * How far the upper-center social row (Social HUD + celebration toast) sits
 * below the very top edge of the safe area - ScreenInsetArea already keeps
 * this clear of the device notch/status bar/rounded corners, so this is only
 * a small additional nudge, same on every platform. Kept deliberately close
 * to the top edge so the pill reads as clearly separate from the gameplay
 * panel below it.
 */
const HUD_TOP_MARGIN = 10

/** Extra vertical separation nudge between the CONNECTIONS pill above and the JOIN panel below it - JOIN only, per real-device feedback that they sat too close together. Every other phase's panel position is untouched. */
const JOIN_EXTRA_TOP_MARGIN = 16

/** Gap between Agenda/Leaderboard/the Social Points counter - the three form one fixed HUD group (see uiMenu), always this same distance apart, never repositioned relative to each other between phases. Reused as-is for the new counter's own gap to Leaderboard, rather than inventing a second gap value - "coherent" per explicit instruction. */
const SOCIAL_HUD_GROUP_GAP = 8

/**
 * Final Social Quest icon - a real PNG asset with its own transparency,
 * replacing the earlier provisional "notebook" look built from plain
 * background rectangles. Rendered via uiBackground.texture +
 * textureMode:'stretch' (no nine-slice), same proven pattern already
 * validated for Social Agenda's own profile pictures (see
 * profilePictureManager.ts / this component's own render).
 *
 * No background/border/box at all anymore - the button IS the PNG, nothing
 * else. Two sizes are tracked separately on purpose:
 * - AGENDA_BUTTON_HIT_AREA_* is the invisible click/tap target (this
 *   component's own outer UiEntity, no uiBackground) - kept comfortably
 *   larger than the icon itself so mobile taps near the icon still land,
 *   even though nothing visible marks its bounds.
 * - AGENDA_BUTTON_ICON_SIZE_* is the icon's own visual size, centered
 *   inside that hit area. IDLE is a deliberate step up from the previous
 *   44.8/39.8 visual size ("ligeramente más grande, que destaquen más").
 *   HOVER/ACTIVE grow a few px further, PRESSED shrinks a few px below
 *   idle for a tactile press-down feel - this SDK has no real glow/
 *   shadow/blur capability (confirmed absent from both UiBackgroundProps
 *   and UiTransformProps in this session's own typings audits), so every
 *   state is expressed purely through this size change, never a box.
 */
const AGENDA_BUTTON_HIT_AREA_WIDE = 72
const AGENDA_BUTTON_HIT_AREA_COMPACT = 64
const AGENDA_BUTTON_ICON_SIZE_WIDE = 60
const AGENDA_BUTTON_ICON_SIZE_HOVER_WIDE = 64
const AGENDA_BUTTON_ICON_SIZE_PRESSED_WIDE = 56
const AGENDA_BUTTON_ICON_SIZE_COMPACT = 52
const AGENDA_BUTTON_ICON_SIZE_HOVER_COMPACT = 56
const AGENDA_BUTTON_ICON_SIZE_PRESSED_COMPACT = 48
const SOCIAL_AGENDA_ICON_PATH = 'assets/images/social-agenda-icon.png'

/**
 * Unseen-Connections badge, overlaid on SocialAgendaButton only - reads as a
 * notification bubble (strong pink, cream text/border), not a second button.
 * Data comes from socialNotificationsManager's own getUnseenConnectionCount()
 * - NOT the total Connections count (that's shown inside Social Agenda's own
 * "N CONNECTIONS" line) - this badge counts only Connections that haven't
 * yet been revealed inside Social Agenda. Stays live because this whole UI
 * tree is re-rendered every frame by ReactEcsRenderer (same reactive pattern
 * as every other dynamic value in this file) - no polling was added.
 *
 * Sized and positioned against AGENDA_BUTTON_HIT_AREA_* (the button's fixed
 * invisible hit area), not against the icon's own size - the icon itself
 * changes size slightly between idle/hover/active/pressed (see
 * AGENDA_BUTTON_ICON_SIZE_* above), and anchoring to the hit area instead
 * keeps the badge perfectly stable/legible through all of that, per
 * explicit instruction. The small negative top/right offset lets it peek
 * out just past the idle icon's corner, the classic "notification bubble"
 * look - the hit area itself is invisible, so a few px of overhang past its
 * bounds changes nothing about the clickable region.
 */
const AGENDA_BADGE_SIZE_WIDE = 22
const AGENDA_BADGE_SIZE_COMPACT = 19
const AGENDA_BADGE_OFFSET_WIDE = -5
const AGENDA_BADGE_OFFSET_COMPACT = -3
const AGENDA_BADGE_FONT_SIZE_WIDE = 13
const AGENDA_BADGE_FONT_SIZE_COMPACT = 12
/** Strong/saturated pink, deliberately distinct from the pale AGENDA_PINK used for text/accents elsewhere - a notification badge needs to read as "alert", not blend in as another soft UI tint. */
const AGENDA_BADGE_BACKGROUND = Color4.create(0.95, 0.2, 0.5, 1)
/** Above this, the badge shows "99+" rather than a growing 3+ digit number that could overflow its own small circle. */
const AGENDA_BADGE_MAX_DISPLAY = 99

/**
 * Social Points counter - a real PNG asset (heart medallion + empty cream
 * number zone), same uiBackground.texture + textureMode:'stretch' pattern as
 * the Agenda/Leaderboard PNG icons. No background/border/box of its own -
 * the image IS the design, per explicit instruction.
 *
 * The asset was replaced with a longer version - natively 2172x724 (3:1
 * exactly, confirmed by reading the file itself, never assumed). WIDTH is
 * now always DERIVED from HEIGHT via SOCIAL_POINTS_COUNTER_ASPECT_RATIO,
 * restoring true aspect-ratio-correct rendering - the earlier manually-
 * widened, ratio-breaking WIDTH_WIDE/WIDTH_COMPACT constants (an accepted
 * stretch trade-off for the OLD 2:1 asset, to fit "999K SP"/"1.5M SP") are
 * gone; the new asset's own extra width already gives text room natively,
 * with no artificial stretch needed. Heights are unchanged from before
 * (same vertical weight next to Agenda/Leaderboard as already established).
 *
 * INITIAL estimate, explicitly not final: the heart medallion is assumed to
 * occupy the left portion of the (now wider) image, the empty cream number
 * zone the remaining right portion (see SOCIAL_POINTS_COUNTER_TEXT_ZONE_WIDTH_PERCENT
 * below, left unchanged from the previous asset pending the user's own visual
 * check with the new one). The text overlay is centered inside that right
 * portion only, never the full width - see SocialPointsCounter's own render.
 */
const SOCIAL_POINTS_COUNTER_ICON_PATH = 'assets/images/social-points-counter.png'
const SOCIAL_POINTS_COUNTER_ASPECT_RATIO = 2172 / 724
const SOCIAL_POINTS_COUNTER_HEIGHT_WIDE = 68
const SOCIAL_POINTS_COUNTER_HEIGHT_COMPACT = 58
/** Width of the absolute text overlay, anchored to the counter's own right edge (the cream zone) - see SocialPointsCounter's own doc comment for why this is an absolute overlay rather than a flex split. Left at the same 72% used for the previous asset - a starting estimate, pending the user's own visual check against the new, wider image. */
const SOCIAL_POINTS_COUNTER_TEXT_ZONE_WIDTH_PERCENT = '72%'
/** Number itself - strong/saturated pink, same AGENDA_BADGE_BACKGROUND color already established for the Connections notification badge, reused here for "Social Quest magenta" rather than inventing a second pink. */
const SOCIAL_POINTS_COUNTER_NUMBER_COLOR = AGENDA_BADGE_BACKGROUND
/** "SP" suffix - teal, same AGENDA_TEAL already used throughout Social Agenda/HUD, per explicit "teal if viable" preference. */
const SOCIAL_POINTS_COUNTER_SUFFIX_COLOR = AGENDA_TEAL
const SOCIAL_POINTS_COUNTER_NUMBER_FONT_SIZE_WIDE = 24
const SOCIAL_POINTS_COUNTER_NUMBER_FONT_SIZE_COMPACT = 19
const SOCIAL_POINTS_COUNTER_SUFFIX_FONT_SIZE_WIDE = 16
const SOCIAL_POINTS_COUNTER_SUFFIX_FONT_SIZE_COMPACT = 13
/** Shown in place of the number while socialPointsCounter is still null (see its own doc comment) - never a possibly-wrong 0. */
const SOCIAL_POINTS_COUNTER_PLACEHOLDER = '--'

/**
 * Abbreviates a Social Points total for the HUD counter ONLY - display
 * formatting, never the real value. `socialPointsCounter` itself (the
 * number this reads) is untouched by this function; the Leaderboard panel
 * keeps showing the exact full number wherever it already does (leaderboardUi.tsx
 * is not touched by this at all), and future reward toasts are expected to
 * show exact amounts too ("+25 SP"), never abbreviated - this helper is
 * HUD-counter-specific by design, not a shared formatter.
 *
 * Rule: below 1000, the exact integer ("435", "999"). At/above 1000,
 * TRUNCATED (never rounded) to one decimal digit plus K/M/B - truncation
 * specifically so e.g. 9999 reads as "9.9K", never "10K" before the player
 * has actually reached 10,000 (rounding would misrepresent a total the
 * player hasn't earned yet; truncating never overstates it). A whole
 * multiple (1000, 10000, 125000) drops the decimal entirely ("1K", "10K",
 * "125K") rather than showing "1.0K".
 */
function formatSocialPointsForHud(value: number): string {
    if (value < 1000) return `${value}`

    const units: Array<[threshold: number, suffix: string]> = [
        [1_000_000_000, 'B'],
        [1_000_000, 'M'],
        [1_000, 'K']
    ]
    for (const [threshold, suffix] of units) {
        if (value >= threshold) {
            const truncatedTenths = Math.floor((value * 10) / threshold)
            const scaled = truncatedTenths / 10
            return `${scaled}${suffix}`
        }
    }
    return `${value}` // unreachable (value >= 1000 always matches the last unit above) - kept as a safe fallback, never throws
}

/** Horizontal gap between the HUD and the celebration toast when shown side by side in WIDE. */
const WIDE_ROW_GAP = 24

/** Horizontal gap between the collapsed HUD pill and a compact celebration toast when shown side by side in normal COMPACT. Smaller than WIDE_ROW_GAP since compact horizontal room is tighter. */
const COMPACT_ROW_GAP = 16

/** Names shown before collapsing the rest into "+N" - shared by both compact toasts. */
const MAX_CELEBRATION_NAMES = 3

/**
 * Social Agenda ("VIEW ALL CONNECTIONS") panel width - it's a user-requested,
 * temporary central overlay (not the persistent HUD), so it's allowed to be
 * noticeably larger than the HUD panel while still leaving scene visible
 * around it. WIDE/COMPACT only, no separate very-small tier: pagination (see
 * AGENDA_ROWS_PER_PAGE) already keeps the panel's height bounded regardless of
 * canvas size, so a third width tier isn't needed to stay safe.
 *
 * Brought down from an earlier 640/460 to the same order of magnitude as
 * leaderboardUi.tsx's own panel (560/420) - the wider version left
 * noticeably empty space to the right of each row's content, which is at
 * most one short line ("84% AFFINITY · 127 SHARED ANSWERS") plus a name and
 * a friendship level. 560 was re-checked to still fit that exact string
 * comfortably at the new, larger AGENDA_SECONDARY_FONT_SIZE_WIDE without
 * wrapping.
 */
const AGENDA_WIDTH_WIDE = 560
const AGENDA_WIDTH_COMPACT = 420

/** Rounds the Social Agenda panel's silhouette - same value/reasoning as leaderboardUi.tsx's own PANEL_BORDER_RADIUS, duplicated for the same "sibling panel, no cross-file dependency" reason as the color constants above. The header matches this on its own top corners only, so its opaque background doesn't square off the panel's rounded top. */
const AGENDA_PANEL_BORDER_RADIUS = 20
const AGENDA_HEADER_BORDER_RADIUS = { topLeft: AGENDA_PANEL_BORDER_RADIUS, topRight: AGENDA_PANEL_BORDER_RADIUS }

/**
 * Minimum height for the desktop (non-mobile) Agenda content area - keeps the
 * panel's total height stable across pages, so a partial last page (fewer
 * than AGENDA_ROWS_PER_PAGE connections) never renders a visibly shorter
 * panel than a full page does. Sized generously for AGENDA_ROWS_PER_PAGE (6)
 * rows at their worst case (every row showing all 3 lines, i.e. a friendship
 * level already reached) plus the "N CONNECTIONS" count line above them - a
 * minHeight, not a fixed height, so a future change to row count/spacing
 * can still grow past it safely. Deliberately NOT applied to the mobile
 * (compactUi) percentage-height variant below (MOBILE_AGENDA_MAX_HEIGHT) -
 * that's an existing, separate responsive mode this reskin doesn't touch.
 *
 * Raised from an earlier 520/430 to account for the larger row typography
 * and the new inter-row divider (see AGENDA_NAME_FONT_SIZE_WIDE and
 * AGENDA_ROW_DIVIDER_COLOR below) - a full 6-row page is now visibly taller,
 * so the "stable height across pages" floor needs to rise with it.
 */
const AGENDA_CONTENT_MIN_HEIGHT_WIDE = 560
const AGENDA_CONTENT_MIN_HEIGHT_COMPACT = 460

/**
 * Row typography, tiered by the same `compactUi` signal (isMobile() || !wide)
 * already used everywhere else in this file - previously every row used one
 * flat size regardless of viewport. Wide sizes are a clear step up from the
 * pre-second-pass flat values (name 20, affinity/shared/friendship/rounds
 * all 16) per explicit feedback that they read too small; compact sizes stay
 * legible without matching wide 1:1, since a narrower panel has less room to
 * spend on text before wrapping starts working against it. Three tiers, name
 * > secondary > tertiary, preserved at both sizes so the visual hierarchy
 * (name -> affinity/shared -> friendship/rounds) never inverts.
 */
const AGENDA_NAME_FONT_SIZE_WIDE = 22
const AGENDA_NAME_FONT_SIZE_COMPACT = 17
/** Affinity + shared answers (line 2). */
const AGENDA_SECONDARY_FONT_SIZE_WIDE = 18
const AGENDA_SECONDARY_FONT_SIZE_COMPACT = 14
/** Friendship level + rounds (line 3). */
const AGENDA_TERTIARY_FONT_SIZE_WIDE = 17
const AGENDA_TERTIARY_FONT_SIZE_COMPACT = 13

/** "N CONNECTIONS" count line - stays MUTED (still secondary metadata) but a touch larger than before (16 -> 17) for slightly more visibility, per explicit feedback that it "works well" but could read a bit stronger. */
const AGENDA_COUNT_FONT_SIZE = 17

/**
 * Each connection's real Decentraland avatar portrait, via
 * uiBackground.avatarTexture (verified in this SDK's own
 * @dcl/react-ecs type definitions - UiBackgroundProps.avatarTexture:
 * UiAvatarTexture, `{ userId: string }`, no other required field). Sized
 * well under the row's own natural height (a 3-line text block already
 * measures ~76 WIDE / ~61 COMPACT at the current font sizes - see the
 * report for this task), so adding it never risks 6 rows no longer fitting
 * a page - confirmed by calculation, not by shrinking anything else.
 *
 * Circular clipping: `borderRadius` is set to exactly half of `size` on the
 * SAME square UiEntity carrying the avatarTexture background, the "cleanest
 * available" approach in this react-ecs (per explicit instruction not to
 * build a complex mask workaround) - this SDK's own border-radius/background
 * clipping is expected to crop the avatar to that circle the same way it
 * would crop a flat color or image texture, though this has not been
 * confirmed in a live preview this session and is worth checking visually.
 * The cream ring is a real 2px border on that same entity. No extra pink/
 * teal accent dot was added on top - an absolutely-positioned overlay is
 * exactly the kind of avoidable complexity the brief itself warned against
 * for an unconfirmed-in-preview feature; the ring alone already delivers
 * the "cute, on-brand medallion" look.
 */
const AGENDA_AVATAR_SIZE_WIDE = 48
const AGENDA_AVATAR_SIZE_COMPACT = 40
const AGENDA_AVATAR_BORDER_WIDTH = 2
const AGENDA_AVATAR_GAP_WIDE = 14
const AGENDA_AVATAR_GAP_COMPACT = 10

/** Dark translucent background for the profile-picture fallback silhouette - same PANEL_BACKGROUND every other dark surface in this scene uses, so an unresolved avatar still reads as "on-brand" rather than a broken placeholder. */
const AGENDA_AVATAR_FALLBACK_BACKGROUND = PANEL_BACKGROUND

/**
 * A very faint horizontal rule between consecutive connections - not a real
 * per-side border (uiTransform's borderWidth/borderColor apply to all four
 * sides at once in this SDK, with no per-side control - same limitation
 * already documented for leaderboardUi.tsx's subtab underline), so this is a
 * separate 1px-tall rectangle instead, low-alpha cream so it reads as a
 * whisper of separation, never a hard boundary or a "card" edge. Skipped
 * after the LAST row on a page (see SocialAgenda) so it never sits as a
 * stray line directly above the pagination footer.
 */
const AGENDA_ROW_DIVIDER_COLOR = Color4.create(0.97, 0.93, 0.86, 0.08)

/**
 * Mobile-only Social Agenda sizing (compactUi = isMobile() || !wide - see its
 * doc comment). Percentage strings, not a fixed virtual-unit width like
 * AGENDA_WIDTH_*: a fixed unit can't reliably express "60-70% of the real
 * device viewport" across the very different aspect ratios mobile landscape
 * devices can have, whereas a percentage resolves against the actual
 * full-screen wrapper this modal already centers in, regardless of device.
 * Narrow-but-non-mobile desktop windows are unaffected - they still use the
 * fixed AGENDA_WIDTH_COMPACT exactly as before, since compactUi (not bare
 * `!wide`) gates this.
 */
const MOBILE_AGENDA_WIDTH = '65%'
const MOBILE_AGENDA_MAX_HEIGHT = '70%'

/**
 * Entries shown per Agenda page. Chosen instead of a scrolling container: the
 * installed SDK (@dcl/react-ecs 7.26.0) only exposes a raw Yoga `overflow:
 * 'scroll'` style flag with no programmatic scroll-position/scrollbar API, and
 * this project already hit one real Explorer-runtime regression from a
 * typings-only-verified component (InteractableArea). Prev/Next pagination
 * built from the same plain UiEntity/Button primitives already proven
 * throughout this file is the reliable choice here, per the explicit
 * "reliability over sophistication" guidance for this feature.
 */
const AGENDA_ROWS_PER_PAGE = 6

/**
 * Maximum names shown per RESULT option column before collapsing the rest into
 * "+N MORE" - keeps the timed, non-scrolling RESULT screen bounded regardless of
 * group size. Same WIDE_MIN_SCALE canvas-scale signal as everywhere else decides
 * which cap applies; no separate very-small tier for the columns themselves (see
 * report - the existing proportional virtual-canvas scaling already degrades
 * gracefully there, same as the rest of the gameplay panel's content).
 */
const REVEAL_MAX_NAMES_WIDE = 5
const REVEAL_MAX_NAMES_COMPACT = 3

/**
 * Per-row height of the RESULT name list, shared by real name rows and the
 * "+N MORE" row alike (unified to the same height so a row count converts to a
 * height with one exact formula). Used to give both A/B ResultColumns an
 * IDENTICAL reserved name-list height regardless of how many names either side
 * actually has - see RevealResults' requiredRows calculation - so the two cards
 * never end up visually unbalanced.
 */
const REVEAL_NAME_ROW_HEIGHT_WIDE = 26
const REVEAL_NAME_ROW_HEIGHT_COMPACT = 20
/** Vertical gap between consecutive name-list rows (both real names and the overflow row). */
const REVEAL_NAME_ROW_GAP = 4

/**
 * Option-title font sizes and reserved title-area height, ResultColumn's option
 * title (e.g. "B — An Exciting Possibility") can wrap to 2 lines for longer
 * question-bank options. Same root cause as the earlier name-overlap bug: a
 * bare wrap-enabled Label's rendered height isn't reliably fed back into this
 * SDK's flex layout, so an unsized wrapper let a 2-line title collide with the
 * stats line below it. Fixed the same proven way - an explicit, fixed-height
 * wrapper around the Label, sized generously enough (checked against the
 * longest known question-bank option strings, ~43 characters) to hold 2 lines
 * regardless of what the Label itself measures to. COMPACT's font is nudged
 * down slightly (16 -> 15) for a bit more breathing room in the narrower card.
 */
const REVEAL_TITLE_FONT_SIZE_WIDE = 20
const REVEAL_TITLE_FONT_SIZE_COMPACT = 15
const REVEAL_TITLE_AREA_HEIGHT_WIDE = 52
const REVEAL_TITLE_AREA_HEIGHT_COMPACT = 38

/** Reserved height for the "N PLAYERS · XX%" stats row - its own fixed-height row below the title area, so the title can never overlap it regardless of how many lines the title wraps to. */
const REVEAL_STATS_ROW_HEIGHT_WIDE = 22
const REVEAL_STATS_ROW_HEIGHT_COMPACT = 18

/**
 * WAITING always uses this compact fixed-size outer panel, on every platform
 * (see uiMenu's isWaitingPhase gate) - WAITING's content is minimal (a short
 * message + a count) on any screen size, so there's no reason to reserve the
 * bigger GAMEPLAY_PANEL_* size ANSWERING/ANSWER LOCKED/RESULT share for it.
 * JOIN keeps its own separate, unrelated sizing (see uiMenu) - untouched here.
 */
const WAITING_PANEL_WIDTH = 480
const WAITING_PANEL_PADDING = 20
const WAITING_TITLE_FONT_SIZE = 24
const WAITING_TITLE_MARGIN_BOTTOM = 6

/** WAITING's own text - fixed, unconditional values now (no wide/compact tiering): the same compact sizing applies on every platform. */
const WAITING_TEXT_FONT_SIZE = 22
const WAITING_TEXT_MARGIN_BOTTOM = 10
const WAITING_COUNT_FONT_SIZE = 17

/** COUNTDOWN's own text - same fixed, unconditional sizing approach as WAITING above. No animation yet, deliberately - just a big static digit per-tick. */
const COUNTDOWN_TITLE_FONT_SIZE = 22
const COUNTDOWN_TITLE_MARGIN_BOTTOM = 12
const COUNTDOWN_NUMBER_FONT_SIZE = 72

/**
 * The one shared outer panel for ANSWERING, ANSWER LOCKED, and RESULT (see
 * uiMenu's isGameplayPanelPhase gate) - same width/padding/position/title on
 * every platform and across all three phases, with a FIXED height (not
 * auto) so the panel never resizes across that phase transition: ANSWER
 * LOCKED's shorter content just leaves blank space at the bottom instead of
 * shrinking the panel, and RESULT's cards have guaranteed room without ever
 * having driven the panel's size themselves. The height only tiers by
 * `compact` (isMobile() || !wide), same signal as everywhere else in this
 * file - GAMEPLAY_PANEL_HEIGHT_WIDE is sized to comfortably fit RESULT's own
 * worst case (REVEAL_MAX_NAMES_WIDE names + the "+N MORE" overflow row),
 * since RESULT's card content itself is unchanged and must always fit.
 */
const GAMEPLAY_PANEL_WIDTH = 760
const GAMEPLAY_PANEL_PADDING = 36
const GAMEPLAY_PANEL_HEIGHT_WIDE = 540
const GAMEPLAY_PANEL_HEIGHT_COMPACT = 430

/**
 * ANSWERING's own content sizing tiers by `compact` (isMobile() || !wide),
 * the same wide/compact-tier pattern RevealResults already uses for RESULT,
 * its already-proven-on-real-mobile reference. The outer panel itself is the
 * shared GAMEPLAY_PANEL_* shell above, not sized here.
 */
const ANSWERING_QUESTION_FONT_SIZE_WIDE = 32
const ANSWERING_QUESTION_FONT_SIZE_COMPACT = 24
const ANSWERING_QUESTION_MARGIN_BOTTOM_WIDE = 28
const ANSWERING_QUESTION_MARGIN_BOTTOM_COMPACT = 14
/**
 * Reserved, fixed height for the question itself - same root cause and same
 * proven fix as ResultColumn's option title / the earlier name-overlap bug
 * (see REVEAL_TITLE_AREA_HEIGHT_*'s own doc comment): a wrap-enabled Label's
 * rendered height isn't reliably fed back into this SDK's flex layout, so a
 * bare wrapped question let its second line visually creep into the timer
 * sitting right below it. Sized generously for 2 lines at the question's own
 * font size (same ~1.3x-line-height ratio already used for REVEAL_TITLE_AREA_
 * HEIGHT_*), so the timer's position is fixed regardless of whether the
 * question renders as 1 or 2 lines - a real reserved zone, not a guess. The
 * question Label is vertically centered inside this box, so a short 1-line
 * question still reads centered rather than pinned to the top.
 */
const ANSWERING_QUESTION_AREA_HEIGHT_WIDE = 88
const ANSWERING_QUESTION_AREA_HEIGHT_COMPACT = 66
const ANSWERING_TIMER_FONT_SIZE_WIDE = 24
const ANSWERING_TIMER_FONT_SIZE_COMPACT = 16
const ANSWERING_TIMER_MARGIN_BOTTOM_WIDE = 28
const ANSWERING_TIMER_MARGIN_BOTTOM_COMPACT = 12
const ANSWERING_LOCKED_LABEL_FONT_SIZE_WIDE = 32
const ANSWERING_LOCKED_LABEL_FONT_SIZE_COMPACT = 18
const ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_WIDE = 12
const ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_COMPACT = 8

/**
 * Answer buttons side by side on every platform. Sized generously up front
 * (not left to auto-measure) for the same reason documented on the reveal
 * name-list fix: a wrapped Label's measured height isn't reliably fed back
 * into this SDK's flex layout. COMPACT keeps the exact values already
 * validated against a real mobile device in production; WIDE keeps its
 * original desktop size.
 */
const ANSWER_BUTTON_WIDTH_WIDE = 260
const ANSWER_BUTTON_HEIGHT_WIDE = 100
const ANSWER_BUTTON_GAP_WIDE = 16
const ANSWER_BUTTON_WIDTH_COMPACT = 200
const ANSWER_BUTTON_HEIGHT_COMPACT = 120
const ANSWER_BUTTON_GAP_COMPACT = 10

/** Dynamic font-size steps by option text length, now applied on BOTH tiers (previously compact-only) - a long option can't overflow its button on desktop either. */
const ANSWER_FONT_SIZE_SHORT_WIDE = 30
const ANSWER_FONT_SIZE_MEDIUM_WIDE = 24
const ANSWER_FONT_SIZE_LONG_WIDE = 18
const ANSWER_FONT_SIZE_SHORT_COMPACT = 20
const ANSWER_FONT_SIZE_MEDIUM_COMPACT = 17
const ANSWER_FONT_SIZE_LONG_COMPACT = 14
const ANSWER_SHORT_MAX_CHARS = 16
const ANSWER_MEDIUM_MAX_CHARS = 28

function answerFontSize(text: string, compact: boolean): number {
    if (text.length <= ANSWER_SHORT_MAX_CHARS) return compact ? ANSWER_FONT_SIZE_SHORT_COMPACT : ANSWER_FONT_SIZE_SHORT_WIDE
    if (text.length <= ANSWER_MEDIUM_MAX_CHARS) return compact ? ANSWER_FONT_SIZE_MEDIUM_COMPACT : ANSWER_FONT_SIZE_MEDIUM_WIDE
    return compact ? ANSWER_FONT_SIZE_LONG_COMPACT : ANSWER_FONT_SIZE_LONG_WIDE
}

/**
 * Reads the SDK-reported live UI canvas size (UiCanvasInformation on engine.RootEntity)
 * and derives the same contain-fit scale factor the renderer itself applies to this
 * scene's declared virtualWidth/virtualHeight (see setupUi above). This is real,
 * per-frame canvas/device data - not a guess based on typical browser window sizes -
 * so it shrinks exactly when the actual rendered UI shrinks, on any platform.
 */
function getUiScale(): number {
    const canvasInfo = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (!canvasInfo) return 1 // no canvas data yet - default to the normal full-size composition
    return Math.min(canvasInfo.width / VIRTUAL_WIDTH, canvasInfo.height / VIRTUAL_HEIGHT)
}

// draw your UI here
export const uiMenu = () => {
    const session = playerSessionManager.getSnapshot()
    const round = roundManager.getSnapshot()
    const scale = getUiScale()
    const wide = scale >= WIDE_MIN_SCALE
    /**
     * The one responsive signal reused everywhere in this file that needs a
     * compact/full-size tier decision. isMobile() (the Explorer's own reported
     * platform, from @dcl/sdk/platform) is OR'd in alongside the scale check
     * rather than replacing it: a real device's canvas-scale math depends on
     * devicePixelRatio in a way that isn't reliably knowable from scene code
     * alone, so a phone could in principle compute `wide === true` and miss
     * compact treatment if scale were the only signal. OR-ing can only WIDEN
     * which cases get the compact tier, never narrow it - desktop (isMobile()
     * always false there) still reduces to exactly `!wide`.
     */
    const compact = isMobile() || !wide
    /** WAITING is the one phase whose outer panel is always the small/compact size, on every platform - see WAITING_PANEL_* constants' doc comment. */
    const isWaitingPhase = round.phase === 'waiting'
    /**
     * COUNTDOWN/ANSWERING/ANSWER LOCKED/RESULT - the phases that share the fixed
     * GAMEPLAY_PANEL_HEIGHT_* shell (see its doc comment). COUNTDOWN included so the
     * panel doesn't resize/flicker right before the question it leads straight into.
     * Requires session.joined: a round already in progress while this player hasn't
     * joined yet renders JoinScreen (via `round.phase !== 'waiting'`, its own
     * "JOIN NEXT ROUND" case), not JoinedGameplay - that JOIN screen keeps its
     * own separate, untouched sizing regardless of round.phase.
     */
    const isGameplayPanelPhase = session.joined && (round.phase === 'countdown' || round.phase === 'answering' || round.phase === 'result')
    /** Mirrors the exact condition JoinScreen renders under, below - used only to add JOIN_EXTRA_TOP_MARGIN to the panel for that one screen. */
    const showingJoinScreen =
        session.inZone && !session.joined && session.isSafeToJoin && round.afkMessage !== 'removed' && round.afkMessage !== 'warning'

    // At most one celebration occupies the notification slot at a time - guaranteed by
    // socialCelebrationQueue.ts itself (a local FIFO presentation queue), not by any
    // priority logic here. The UI is a pure consumer: it renders whichever single
    // celebration (if any) the queue says is currently presented, full stop.
    const presented = getPresentedCelebration()
    const presentedNewConnection = presented?.type === 'NEW_CONNECTION' ? presented : null
    const presentedFriendship = presented?.type === 'FRIENDSHIP' ? presented : null

    // Gameplay always wins: if the Social Agenda is open and the player's own question
    // now needs attention, close it automatically rather than let it compete for the
    // screen. Opening it in the first place is separately guarded the same way (see
    // SocialAgendaButton's own onMouseDown guard). Two triggers: ANSWERING begins WHILE
    // it's already open (the original rule), and - since the gameplay panel at
    // `session.inZone && !socialAgendaOpen` below is otherwise fully hidden behind an
    // open Agenda - walking into the Quest Zone *before joining* with the Agenda left
    // open from outside, which used to leave JOIN permanently hidden until the player
    // closed it manually. Deliberately NOT triggered by session.inZone alone once
    // joined: the Agenda must stay openable during WAITING/RESULT for an already-joined
    // player, same as before this fix. Local UI state only; never touches joined status
    // or round lifecycle.
    if (socialAgendaOpen && ((round.phase === 'answering' || round.phase === 'countdown') || (session.inZone && !session.joined))) {
        socialAgendaOpen = false
    }
    // Phase 2B-4: deliberately NOT the same rule as Social Agenda above.
    // Leaderboard is scene-level social information, reachable from the
    // physical panel without JOIN - unlike Agenda, it must never auto-close
    // just because the player is standing in the Quest Zone unjoined
    // (`session.inZone && !session.joined`), even though that means it can
    // sit in front of the JOIN screen while open. It still closes the
    // instant real gameplay needs the screen, same as Agenda - now also
    // including COUNTDOWN, so the pre-round countdown reads clean and visible.
    if (isLeaderboardOpen() && (round.phase === 'answering' || round.phase === 'countdown')) {
        closeLeaderboard()
    }

    // Social Agenda closed (by any path above, the header's own close tap, or the
    // mutual-exclusion callback below) - this opening's reveal state belongs only to
    // the opening that just ended. A plain boolean/length check, not a poll of
    // anything meaningful changing frame-to-frame - cheap to check unconditionally.
    if (!socialAgendaOpen && (agendaRevealedConnectionIds.length > 0 || notificationsHydratedSeenLocally)) {
        agendaRevealedConnectionIds = []
        notificationsHydratedSeenLocally = false
    }

    if (socialAgendaOpen) {
        // Notifications hydration landed WHILE Agenda was already open (see
        // isNotificationsHydrated's own doc comment on why Agenda never blocks
        // opening on this) - reveal everything it just brought in, exactly once,
        // via a single boolean edge-detect rather than diffing any array.
        if (!notificationsHydratedSeenLocally && isNotificationsHydrated()) {
            notificationsHydratedSeenLocally = true
            revealUnseenConnections(getUnseenConnectionIds())
        }
        // A brand new Connection arrived live while Agenda is already open (see
        // socialNotificationsManager.ts's own tick()/drainPendingReveal doc
        // comments) - drains an already-computed queue, never polls/diffs.
        revealUnseenConnections(drainPendingReveal())
    }

    // Applies any Social Points rewards detected since the last frame to the HUD
    // counter - ONLY once a real baseline exists (socialPointsCounter !== null).
    // While it's still null, consumePendingCounterAmount() is deliberately never
    // called, so amounts stay safely accumulated inside socialPointsFeedback.ts
    // itself (see its own doc comment) - the moment the baseline lands, this same
    // check (now true) drains everything accumulated so far in one shot, applying
    // it exactly once. Unconditional on Agenda/Leaderboard open state - the
    // counter is always visible in the HUD.
    if (socialPointsCounter !== null) {
        const pendingSocialPointsAmount = consumePendingCounterAmount()
        if (pendingSocialPointsAmount !== 0) {
            socialPointsCounter += pendingSocialPointsAmount
            triggerSocialPointsCounterPop()
        }
    }
    const activeSocialPointsReward = getActiveSocialPointsReward()

    return (
        // Keeps the panel clear of the device notch, status bar and rounded corners on mobile
        <ScreenInsetArea>
            {/* Persistent Social HUD + temporary celebrations, upper-center: real Explorer
                testing showed all four corners are native-UI territory (Explorer controls
                top-left/top-right, chat bottom-left, other controls bottom-right), so this is
                the one region confirmed visually clear. Sits HUD_TOP_MARGIN below the safe-area
                edge (ScreenInsetArea already handles the real device safe area) - same small
                offset on every platform, deliberately close to the top edge so the pill reads
                as clearly separate from the gameplay panel below it.

                Same fixed two-slot layout on every platform (not "center the group"): a
                LEFT/ANCHOR slot exactly 50% wide with Connections right-aligned inside it, so
                Connections' right edge always sits exactly on the horizontal center line - and
                a RIGHT slot, also always 50% wide whether or not it has content, holding the
                current celebration left-aligned just past that same line. Because both slot
                widths are fixed regardless of content, Connections' anchor can never shift when
                a celebration appears or disappears - unlike centering the pair as a single
                group, which moved Connections depending on the celebration's width. */}
            <UiEntity
                uiTransform={{
                    positionType: 'absolute',
                    position: { top: HUD_TOP_MARGIN },
                    width: '100%',
                    flexDirection: 'row',
                    alignItems: 'flex-start'
                }}
            >
                <UiEntity uiTransform={{ width: '50%', flexDirection: 'row', justifyContent: 'flex-end' }}>
                    {/* Fixed HUD group [ AGENDA ][ LEADERBOARD ][ SP COUNTER ], always visible
                        on every platform and in every phase (including ANSWERING/ANSWER
                        LOCKED) - same fixed position and same three elements throughout, never
                        hidden, reordered, or moved. Connections' own count is no longer
                        duplicated here as a separate indicator - Social Agenda is the one place
                        that shows it ("N CONNECTIONS", see its own header). SocialAgendaButton's
                        tap is disabled (no-op) during ANSWERING/ANSWER LOCKED - see its own doc
                        comment - so the player can never cover the question or lose response
                        time. SocialPointsCounter has no tap handler at all, same reasoning as
                        the retired Connections pill. */}
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                        <SocialAgendaButton wide={wide} />
                        <UiEntity uiTransform={{ width: SOCIAL_HUD_GROUP_GAP }} />
                        <LeaderboardButton wide={wide} onOpen={() => { socialAgendaOpen = false }} />
                        <UiEntity uiTransform={{ width: SOCIAL_HUD_GROUP_GAP }} />
                        <SocialPointsCounter wide={wide} />
                        {/* Absolutely positioned within THIS row - flush to its bottom-right
                            corner, roughly under the counter - so it never affects the row's
                            own flex layout (Agenda/Leaderboard/Counter never shift because of
                            it). Always VALID_ROUND now - socialPointsFeedback.ts's own
                            presentationQueue never queues a FRIENDSHIP_BONUS reward anymore
                            (that bonus shows inline inside NewConnectionToast/FriendshipToast
                            instead - see their own doc comments), so getActiveSocialPointsReward()
                            can only ever return one of those here. First-pass placement only,
                            per explicit instruction to validate timing/queue/counter-increment/
                            animation before any visual polish. */}
                        {activeSocialPointsReward && <SocialPointsValidRoundToast data={activeSocialPointsReward} wide={wide} />}
                    </UiEntity>
                </UiEntity>
                {/* Compact toast presentation for the right slot on every platform - the large
                    cards felt unnecessarily obtrusive and were retired (see ui.tsx history).
                    `wide` still only affects the gap width here, never which presentation is
                    chosen. */}
                <UiEntity uiTransform={{ width: '50%', flexDirection: 'row', justifyContent: 'flex-start' }}>
                    {presentedNewConnection && (
                        <UiEntity uiTransform={{ margin: { left: wide ? WIDE_ROW_GAP : COMPACT_ROW_GAP } }}>
                            <NewConnectionToast data={presentedNewConnection} />
                        </UiEntity>
                    )}
                    {presentedFriendship && (
                        <UiEntity uiTransform={{ margin: { left: wide ? WIDE_ROW_GAP : COMPACT_ROW_GAP } }}>
                            <FriendshipToast data={presentedFriendship} />
                        </UiEntity>
                    )}
                </UiEntity>
            </UiEntity>

            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: '100%',
                    justifyContent: 'center',
                    alignItems: 'center'
                }}
            >
                {/* Presence in the scene is not participation: outside the Quest Zone, show nothing at all.
                    Also suppressed while the Social Agenda is open - both panels are translucent, so
                    rendering them together let the gameplay panel show through underneath the Agenda.
                    The Agenda temporarily owns this central area instead; gameplay reappears the instant
                    socialAgendaOpen goes false (including via the existing ANSWERING auto-close rule). */}
                {session.inZone && !socialAgendaOpen && !isLeaderboardOpen() && (
                    <UiEntity
                        uiTransform={{
                            width: isWaitingPhase ? WAITING_PANEL_WIDTH : GAMEPLAY_PANEL_WIDTH,
                            height: isGameplayPanelPhase ? (compact ? GAMEPLAY_PANEL_HEIGHT_COMPACT : GAMEPLAY_PANEL_HEIGHT_WIDE) : undefined,
                            padding: isWaitingPhase ? WAITING_PANEL_PADDING : GAMEPLAY_PANEL_PADDING,
                            margin: { top: showingJoinScreen ? JOIN_EXTRA_TOP_MARGIN : 0 },
                            flexDirection: 'column',
                            alignItems: 'center'
                        }}
                        uiBackground={{ color: Color4.create(0.05, 0.05, 0.1, 0.85) }}
                    >
                        <Label
                            value="SOCIAL QUEST"
                            fontSize={isWaitingPhase ? WAITING_TITLE_FONT_SIZE : 56}
                            color={Color4.create(1, 0.85, 0.2, 1)}
                            uiTransform={{ margin: { bottom: isWaitingPhase ? WAITING_TITLE_MARGIN_BOTTOM : 18 } }}
                        />

                        {round.afkMessage === 'removed' ? (
                            <UiEntity uiTransform={COLUMN_CENTERED}>
                                <Label
                                    value="REMOVED FOR INACTIVITY"
                                    fontSize={30}
                                    color={Color4.create(1, 0.5, 0.4, 1)}
                                    uiTransform={{ margin: { bottom: 12 } }}
                                />
                                <Label value="You missed 2 questions." fontSize={22} color={MUTED} />
                            </UiEntity>
                        ) : round.afkMessage === 'warning' ? (
                            <UiEntity uiTransform={COLUMN_CENTERED}>
                                <Label
                                    value="STILL THERE?"
                                    fontSize={30}
                                    color={Color4.create(1, 0.85, 0.2, 1)}
                                    uiTransform={{ margin: { bottom: 12 } }}
                                />
                                <Label
                                    value="Answer the next question to stay in Social Quest."
                                    fontSize={20}
                                    textAlign="middle-center"
                                    textWrap="wrap"
                                    color={MUTED}
                                />
                            </UiEntity>
                        ) : !session.isSafeToJoin ? (
                            <Label value="PREPARING SOCIAL QUEST..." fontSize={32} color={MUTED} />
                        ) : !session.joined ? (
                            <JoinScreen />
                        ) : (
                            <JoinedGameplay />
                        )}
                    </UiEntity>
                )}
            </UiEntity>

            {/* Social Agenda - a user-requested temporary overlay, rendered last so it sits on
                top of the gameplay panel when both happen to be visible. Centered the same way
                the gameplay panel itself is (full-screen wrapper, justifyContent/alignItems
                center) - a proven technique already used above, not a new positioning system.
                Deliberately does not coordinate with the celebration toast in the fixed upper
                row: that row is untouched and keeps rendering normally regardless of Agenda's
                open state (see report for why this is the chosen simplest-safe behavior). */}
            {socialAgendaOpen && (
                <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }}>
                    <SocialAgenda wide={wide} compactUi={compact} />
                </UiEntity>
            )}

            {isLeaderboardOpen() && (
                <UiEntity uiTransform={{ positionType: 'absolute', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' }}>
                    <LeaderboardPanel wide={wide} />
                </UiEntity>
            )}
        </ScreenInsetArea>
    )
}

/** Shown while standing in the Quest Zone, before pressing JOIN. */
const JoinScreen = () => {
    const round = roundManager.getSnapshot()
    const roundAlreadyActive = !round.isSyncing && round.phase !== 'waiting'

    return (
        <UiEntity uiTransform={COLUMN_CENTERED}>
            {roundAlreadyActive && (
                <Label
                    value={`${round.activeParticipantCount} PLAYERS ACTIVE`}
                    fontSize={24}
                    color={MUTED}
                    uiTransform={{ margin: { bottom: 16 } }}
                />
            )}
            <Button
                value={roundAlreadyActive ? 'JOIN NEXT ROUND' : 'JOIN SOCIAL QUEST'}
                variant="primary"
                fontSize={28}
                uiTransform={{ width: 320, height: 90 }}
                onMouseDown={() => playerSessionManager.joinSocialQuest()}
            />
        </UiEntity>
    )
}

/** Shown once the local player has pressed JOIN - covers pending/waiting/answering/result. */
const JoinedGameplay = () => {
    const { phase, isPending, activeParticipantCount, question, selectedOption, secondsLeft, isRevealing, reveal } =
        roundManager.getSnapshot()
    const wide = getUiScale() >= WIDE_MIN_SCALE
    // Same isMobile()-OR'd signal as uiMenu's own `compact` - see its doc comment.
    const compact = isMobile() || !wide

    if (isPending) {
        return (
            <UiEntity uiTransform={COLUMN_CENTERED}>
                <Label
                    value="JOINING NEXT ROUND..."
                    fontSize={32}
                    textAlign="middle-center"
                    textWrap="wrap"
                    color={Color4.White()}
                />
            </UiEntity>
        )
    }

    if (phase === 'waiting') {
        return (
            <UiEntity uiTransform={COLUMN_CENTERED}>
                <Label
                    value="WAITING FOR ANOTHER PLAYER..."
                    fontSize={WAITING_TEXT_FONT_SIZE}
                    textAlign="middle-center"
                    textWrap="wrap"
                    color={Color4.White()}
                    uiTransform={{ width: '100%', margin: { bottom: WAITING_TEXT_MARGIN_BOTTOM } }}
                />
                <Label
                    value={`${activeParticipantCount} / ${MIN_PLAYERS_REQUIRED}`}
                    fontSize={WAITING_COUNT_FONT_SIZE}
                    color={MUTED}
                />
            </UiEntity>
        )
    }

    if (phase === 'countdown') {
        return (
            <UiEntity uiTransform={COLUMN_CENTERED}>
                <Label
                    value="SOCIAL QUEST STARTS IN"
                    fontSize={COUNTDOWN_TITLE_FONT_SIZE}
                    textAlign="middle-center"
                    textWrap="wrap"
                    color={Color4.White()}
                    uiTransform={{ width: '100%', margin: { bottom: COUNTDOWN_TITLE_MARGIN_BOTTOM } }}
                />
                <Label value={`${secondsLeft}`} fontSize={COUNTDOWN_NUMBER_FONT_SIZE} color={Color4.create(1, 0.85, 0.2, 1)} />
            </UiEntity>
        )
    }

    // Guaranteed non-null by RoundManager whenever phase is 'answering' or 'result'
    const activeQuestion = question as NonNullable<typeof question>
    const selectedLabel =
        selectedOption === 'A' ? activeQuestion.optionA : selectedOption === 'B' ? activeQuestion.optionB : null

    return (
        <UiEntity uiTransform={COLUMN_CENTERED}>
            {/* Fixed-height reserved zone for the question - see ANSWERING_QUESTION_AREA_HEIGHT_*'s
                own doc comment. Its bottom edge (and therefore the timer's position right below it)
                never moves, whether the question renders as 1 or 2 lines. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: compact ? ANSWERING_QUESTION_AREA_HEIGHT_COMPACT : ANSWERING_QUESTION_AREA_HEIGHT_WIDE,
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    margin: { bottom: compact ? ANSWERING_QUESTION_MARGIN_BOTTOM_COMPACT : ANSWERING_QUESTION_MARGIN_BOTTOM_WIDE }
                }}
            >
                <Label
                    value={activeQuestion.question}
                    fontSize={compact ? ANSWERING_QUESTION_FONT_SIZE_COMPACT : ANSWERING_QUESTION_FONT_SIZE_WIDE}
                    textAlign="middle-center"
                    textWrap="wrap"
                    color={Color4.White()}
                    uiTransform={{ width: '100%' }}
                />
            </UiEntity>

            {phase === 'answering' ? (
                <UiEntity uiTransform={COLUMN_CENTERED}>
                    {/* Countdown: visible but kept small so it stays secondary to the question/buttons */}
                    <Label
                        value={`${secondsLeft}s`}
                        fontSize={compact ? ANSWERING_TIMER_FONT_SIZE_COMPACT : ANSWERING_TIMER_FONT_SIZE_WIDE}
                        color={MUTED}
                        uiTransform={{ margin: { bottom: compact ? ANSWERING_TIMER_MARGIN_BOTTOM_COMPACT : ANSWERING_TIMER_MARGIN_BOTTOM_WIDE } }}
                    />

                    {selectedOption === null ? (
                        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                            <Button
                                value={activeQuestion.optionA}
                                variant="primary"
                                fontSize={answerFontSize(activeQuestion.optionA, compact)}
                                textWrap="wrap"
                                uiTransform={
                                    compact
                                        ? { width: ANSWER_BUTTON_WIDTH_COMPACT, height: ANSWER_BUTTON_HEIGHT_COMPACT, margin: { right: ANSWER_BUTTON_GAP_COMPACT } }
                                        : { width: ANSWER_BUTTON_WIDTH_WIDE, height: ANSWER_BUTTON_HEIGHT_WIDE, margin: { right: ANSWER_BUTTON_GAP_WIDE } }
                                }
                                onMouseDown={() => roundManager.selectOption('A')}
                            />
                            <Button
                                value={activeQuestion.optionB}
                                variant="primary"
                                fontSize={answerFontSize(activeQuestion.optionB, compact)}
                                textWrap="wrap"
                                uiTransform={
                                    compact
                                        ? { width: ANSWER_BUTTON_WIDTH_COMPACT, height: ANSWER_BUTTON_HEIGHT_COMPACT, margin: { left: ANSWER_BUTTON_GAP_COMPACT } }
                                        : { width: ANSWER_BUTTON_WIDTH_WIDE, height: ANSWER_BUTTON_HEIGHT_WIDE, margin: { left: ANSWER_BUTTON_GAP_WIDE } }
                                }
                                onMouseDown={() => roundManager.selectOption('B')}
                            />
                        </UiEntity>
                    ) : (
                        <UiEntity uiTransform={COLUMN_CENTERED}>
                            <Label
                                value="ANSWER LOCKED"
                                fontSize={compact ? ANSWERING_LOCKED_LABEL_FONT_SIZE_COMPACT : ANSWERING_LOCKED_LABEL_FONT_SIZE_WIDE}
                                color={Color4.create(0.6, 1, 0.6, 1)}
                                uiTransform={{ margin: { bottom: compact ? ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_COMPACT : ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_WIDE } }}
                            />
                            <Label
                                value={selectedLabel as string}
                                fontSize={answerFontSize(selectedLabel as string, compact)}
                                textAlign="middle-center"
                                textWrap="wrap"
                                color={Color4.White()}
                                uiTransform={{ width: '100%' }}
                            />
                        </UiEntity>
                    )}
                </UiEntity>
            ) : (
                <UiEntity uiTransform={COLUMN_CENTERED}>
                    {isRevealing || !reveal ? (
                        <Label value="REVEALING..." fontSize={32} color={MUTED} />
                    ) : (
                        <RevealResults optionAText={activeQuestion.optionA} optionBText={activeQuestion.optionB} reveal={reveal} />
                    )}
                </UiEntity>
            )}
        </UiEntity>
    )
}

/**
 * Two-column RESULT presentation: LEFT = Option A, RIGHT = Option B, equally
 * weighted (no winner/loser framing, no ranking). Purely a renderer of the
 * `reveal` snapshot it's given - reveal.entries/countA/countB are already
 * recomputed live every RoundManager.getSnapshot() call during RESULT (to
 * absorb late-arriving answers), and this component re-derives names/counts/
 * percentages/+N from that snapshot on every render, so a late answer updates
 * the columns automatically with no frozen state of its own. NO_ANSWER entries
 * (entry.option === null) are simply not included in either column, preserving
 * the existing reveal rule that they're excluded from the A/B comparison - no
 * third column was added.
 */
const RevealResults = ({ optionAText, optionBText, reveal }: { optionAText: string; optionBText: string; reveal: RevealData }) => {
    const wide = getUiScale() >= WIDE_MIN_SCALE
    const maxNames = wide ? REVEAL_MAX_NAMES_WIDE : REVEAL_MAX_NAMES_COMPACT

    const entriesA = reveal.entries.filter((entry) => entry.option === 'A')
    const entriesB = reveal.entries.filter((entry) => entry.option === 'B')

    // Both columns must render at the SAME height regardless of how many names either side
    // actually has (no winner/loser framing via card size) - so the "row budget" a column
    // reserves for its name list is the larger of what EITHER side needs, not its own count.
    // +1 accounts for the "+N MORE" overflow row when a side exceeds maxNames.
    const rowsNeededFor = (entries: RevealEntry[]) => Math.min(entries.length, maxNames) + (entries.length > maxNames ? 1 : 0)
    const requiredRows = Math.max(rowsNeededFor(entriesA), rowsNeededFor(entriesB))

    // Percentages are of VALID A/B answers only (never NO_ANSWER, never total participant
    // count) - matches the existing reveal rule that countA/countB already exclude NO_ANSWER.
    // percentB is derived as the complement of percentA (not independently rounded) so the
    // two displayed percentages always sum to exactly 100% - rounding both sides separately
    // can otherwise land on totals like 101% (e.g. 1/8 -> 13%, 7/8 -> 88%).
    const totalValid = reveal.countA + reveal.countB
    const percentA = totalValid > 0 ? Math.round((reveal.countA / totalValid) * 100) : 0
    const percentB = totalValid > 0 ? 100 - percentA : 0

    return (
        <UiEntity uiTransform={COLUMN_CENTERED}>
            <Label value="RESULTS" fontSize={32} color={Color4.create(0.85, 0.75, 1, 1)} uiTransform={{ margin: { bottom: 16 } }} />
            <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start' }}>
                <ResultColumn
                    label="A"
                    optionText={optionAText}
                    count={reveal.countA}
                    percent={percentA}
                    entries={entriesA}
                    maxNames={maxNames}
                    nameListRows={requiredRows}
                    wide={wide}
                />
                <UiEntity uiTransform={{ width: wide ? 24 : 14 }} />
                <ResultColumn
                    label="B"
                    optionText={optionBText}
                    count={reveal.countB}
                    percent={percentB}
                    entries={entriesB}
                    maxNames={maxNames}
                    nameListRows={requiredRows}
                    wide={wide}
                />
            </UiEntity>
        </UiEntity>
    )
}

/**
 * One RESULT option column. Both A and B use identical styling/weight - a shared
 * violet/lavender accent, no green/red, no "winner" treatment - per the "social
 * discovery, not competition" direction. Names are `entry.name`, resolved exactly
 * as before by roundManager's own buildRevealData() (unchanged) - not the
 * separate getDisplayNameFor/Questmate cache the HUD/Agenda/celebrations use,
 * since reveal names were already resolving correctly before this task and this
 * is presentation-only.
 */
const ResultColumn = ({
    label,
    optionText,
    count,
    percent,
    entries,
    maxNames,
    nameListRows,
    wide
}: {
    label: 'A' | 'B'
    optionText: string
    count: number
    percent: number
    entries: RevealEntry[]
    maxNames: number
    /** Shared row budget from RevealResults (the larger of what either A or B needs) - both columns reserve this same amount of name-list height, so neither card's size depends on its own content alone. */
    nameListRows: number
    wide: boolean
}) => {
    const shown = entries.slice(0, maxNames)
    const remaining = entries.length - shown.length
    const rowHeight = wide ? REVEAL_NAME_ROW_HEIGHT_WIDE : REVEAL_NAME_ROW_HEIGHT_COMPACT
    // Fixed height for nameListRows rows plus the gaps between them (none if there are no rows at all).
    const nameListHeight = nameListRows > 0 ? nameListRows * rowHeight + (nameListRows - 1) * REVEAL_NAME_ROW_GAP : 0

    return (
        <UiEntity
            uiTransform={{
                width: wide ? 320 : 220,
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: wide ? 18 : 12,
                borderColor: Color4.create(0.6, 0.45, 0.85, 1),
                borderWidth: 1,
                borderRadius: 10
            }}
            uiBackground={{ color: Color4.create(0.16, 0.09, 0.22, 0.85) }}
        >
            {/* Option title: its own explicit-height wrapper, same reliable technique as the
                name-list fix - the wrapped Label's own measured height isn't trusted, so the
                stats row below is positioned relative to this fixed box instead, regardless of
                whether the title actually renders as 1 or 2 lines. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: wide ? REVEAL_TITLE_AREA_HEIGHT_WIDE : REVEAL_TITLE_AREA_HEIGHT_COMPACT,
                    alignItems: 'flex-start',
                    margin: { bottom: 8 }
                }}
            >
                <Label
                    value={`${label} — ${optionText}`}
                    fontSize={wide ? REVEAL_TITLE_FONT_SIZE_WIDE : REVEAL_TITLE_FONT_SIZE_COMPACT}
                    color={Color4.create(0.85, 0.75, 1, 1)}
                    textWrap="wrap"
                    uiTransform={{ width: '100%' }}
                />
            </UiEntity>
            {/* Stats row: same fixed-height-wrapper treatment, so it can never overlap the
                names below it either. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: wide ? REVEAL_STATS_ROW_HEIGHT_WIDE : REVEAL_STATS_ROW_HEIGHT_COMPACT,
                    alignItems: 'flex-start',
                    margin: { bottom: 12 }
                }}
            >
                <Label value={`${count} PLAYER${count === 1 ? '' : 'S'} · ${percent}%`} fontSize={wide ? 16 : 13} color={MUTED} />
            </UiEntity>
            {/* Each name gets its own row container with an EXPLICIT height - the previous bare,
                wrap-enabled Labels stacked directly in this flex column didn't reliably report
                their wrapped-text height back into layout, so Yoga gave successive rows ~zero
                space and the names visually collapsed onto each other. A fixed row height sidesteps
                that text-measurement fragility entirely: it's correct regardless of what the text
                measures to, so rows can never overlap. Single-line (no textWrap) for the same
                reason - reliability over wrapping, per the SDK behavior actually observed here;
                an unusually long name may extend past the card rather than wrap, which is a lesser,
                pre-existing limitation (the original flat reveal list never truncated names either),
                not a regression from this fix. */}
            {/* Fixed-height list zone, sized from the SHARED nameListRows budget (not this
                column's own entry count) - this is what keeps the A and B cards the same
                total height even when one side has several names and the other has none.
                The emptier side just leaves clean blank space here; no fake placeholder
                names or "Nobody" text is ever rendered. */}
            <UiEntity uiTransform={{ width: '100%', height: nameListHeight, flexDirection: 'column' }}>
                {shown.map((entry, index) => {
                    const isLastRow = remaining === 0 && index === shown.length - 1
                    return (
                        <UiEntity
                            key={entry.userId}
                            uiTransform={{ width: '100%', height: rowHeight, alignItems: 'center', margin: { bottom: isLastRow ? 0 : REVEAL_NAME_ROW_GAP } }}
                        >
                            <Label value={entry.name} fontSize={wide ? 18 : 14} color={Color4.White()} />
                        </UiEntity>
                    )
                })}
                {remaining > 0 && (
                    <UiEntity uiTransform={{ width: '100%', height: rowHeight, alignItems: 'center' }}>
                        <Label value={`+${remaining} MORE`} fontSize={wide ? 15 : 12} color={MUTED} />
                    </UiEntity>
                )}
            </UiEntity>
        </UiEntity>
    )
}

/**
 * Third element of the fixed HUD group, alongside SocialAgendaButton/
 * LeaderboardButton (see uiMenu) - purely informational, no tap handler at
 * all (mirrors the retired Connections pill's own "information only, no
 * action" role, not a coincidence - same reasoning: a number should never
 * double as a button). Renders the social-points-counter.png medallion at
 * its own aspect-ratio-correct size, with the current total (or a
 * placeholder - see socialPointsCounter's own doc comment) drawn as an
 * absolute overlay anchored to the cream zone (right side) - never a full-
 * width layout, since the left side is the heart medallion baked into the
 * image itself. See the overlay's own doc comment for why it's an absolute
 * overlay rather than a flex sibling splitting the counter's own width.
 */
const SocialPointsCounter = ({ wide }: { wide: boolean }) => {
    const baseHeight = wide ? SOCIAL_POINTS_COUNTER_HEIGHT_WIDE : SOCIAL_POINTS_COUNTER_HEIGHT_COMPACT
    const baseWidth = baseHeight * SOCIAL_POINTS_COUNTER_ASPECT_RATIO
    const numberFontSize = wide ? SOCIAL_POINTS_COUNTER_NUMBER_FONT_SIZE_WIDE : SOCIAL_POINTS_COUNTER_NUMBER_FONT_SIZE_COMPACT
    const suffixFontSize = wide ? SOCIAL_POINTS_COUNTER_SUFFIX_FONT_SIZE_WIDE : SOCIAL_POINTS_COUNTER_SUFFIX_FONT_SIZE_COMPACT
    // formatSocialPointsForHud abbreviates for DISPLAY only - socialPointsCounter itself
    // (the real local total) is never modified here or anywhere else by this formatting.
    const numberText = socialPointsCounter === null ? SOCIAL_POINTS_COUNTER_PLACEHOLDER : formatSocialPointsForHud(socialPointsCounter)
    // Popped size, applied to width AND height together so the aspect ratio is
    // never deformed (see getSocialPointsCounterPopScale's own doc comment). The
    // OUTER UiEntity below stays fixed at the base size so this pop never shifts
    // Agenda/Leaderboard's own flex layout - only the inner, visual entity grows/
    // shrinks, centered within that fixed outer footprint.
    const popScale = getSocialPointsCounterPopScale()
    const poppedHeight = baseHeight * popScale
    const poppedWidth = baseWidth * popScale

    return (
        <UiEntity uiTransform={{ width: baseWidth, height: baseHeight, justifyContent: 'center', alignItems: 'center' }}>
        <UiEntity
            uiTransform={{ width: poppedWidth, height: poppedHeight }}
            uiBackground={{ texture: { src: SOCIAL_POINTS_COUNTER_ICON_PATH }, textureMode: 'stretch' }}
        >
            {/* Text area is an ABSOLUTE overlay anchored to the cream zone (right side),
                NOT a flex sibling splitting the counter's own width - an earlier 50/50
                flex split left too little room for "435 SP" at this font size and caused
                per-character wrapping (Yoga's default textWrap:'wrap', confirmed in
                @dcl/react-ecs's own typings). An absolute overlay is free to be as wide as
                needed while still anchored to the right edge via `position:{right:0}`, so
                it still reads as "over the cream zone" without being clipped to a strict
                fraction. `textWrap:'nowrap'` on both Labels (explicit, not the default)
                plus `flexShrink:0` is what actually stops wrapping - confirmed real props.
                Values are abbreviated (formatSocialPointsForHud) specifically so this
                overlay never needs to hold more than ~4-5 characters ("999K", "1.5M") no
                matter how large the real total grows - see that function's own doc
                comment. Width/offset here are still a first pass pending the user's own
                visual check. */}
            <UiEntity
                uiTransform={{
                    positionType: 'absolute',
                    position: { right: 0, top: 0 },
                    width: SOCIAL_POINTS_COUNTER_TEXT_ZONE_WIDTH_PERCENT,
                    height: '100%',
                    flexDirection: 'row',
                    justifyContent: 'center',
                    alignItems: 'center'
                }}
            >
                <Label
                    value={numberText}
                    fontSize={numberFontSize}
                    color={socialPointsCounter === null ? MUTED : SOCIAL_POINTS_COUNTER_NUMBER_COLOR}
                    textWrap="nowrap"
                    uiTransform={{ flexShrink: 0 }}
                />
                <Label
                    value=" SP"
                    fontSize={suffixFontSize}
                    color={socialPointsCounter === null ? MUTED : SOCIAL_POINTS_COUNTER_SUFFIX_COLOR}
                    textWrap="nowrap"
                    uiTransform={{ flexShrink: 0 }}
                />
            </UiEntity>
        </UiEntity>
        </UiEntity>
    )
}

/**
 * VALID_ROUND-only micro toast: a real PNG heart (assets/images/social-points-valid-heart.png,
 * confirmed 1254x1254 - a real 1:1 square, RGBA with alpha), with ONLY "+1"
 * text INSIDE it (generated by code, no baked-in text) - no "SP" here
 * anymore, since the main counter already carries that suffix and repeating
 * it inside a small, frequent micro toast added noise without adding
 * information. No uiBackground/border/capsule of its own - "contenedor
 * transparente" per explicit instruction. "+1" uses AGENDA_CREAM (warm
 * off-white) rather than the usual strong pink, specifically for legibility
 * against the heart's own reddish/pink artwork - a deliberate contrast
 * call, still within the established cream/pink/teal Social Quest palette,
 * not a new color; tried first per explicit priority order, kept because it
 * already reads clearly.
 *
 * Slightly bigger than the previous pass, specifically to give the single
 * "+1" real breathing room now that it's alone inside the heart (no longer
 * sharing space with "SP"). A small vertical nudge
 * (SOCIAL_POINTS_VALID_ROUND_TEXT_OPTICAL_OFFSET_Y) shifts the text up from
 * the heart's exact mathematical center - hearts carry most of their visual
 * "mass" in the two upper lobes before tapering to a bottom point, so a
 * perfectly centered number tends to read as sitting slightly too low/close
 * to the point. First-pass value, pending the user's own visual check.
 */
const SOCIAL_POINTS_VALID_ROUND_HEART_ICON_PATH = 'assets/images/social-points-valid-heart.png'
const SOCIAL_POINTS_VALID_ROUND_HEART_SIZE_WIDE = 64
const SOCIAL_POINTS_VALID_ROUND_HEART_SIZE_COMPACT = 52
const SOCIAL_POINTS_VALID_ROUND_AMOUNT_FONT_SIZE_WIDE = 26
const SOCIAL_POINTS_VALID_ROUND_AMOUNT_FONT_SIZE_COMPACT = 21
/** Upward nudge (px, at 1x/full scale) for optical centering - see this block's own doc comment. Scaled by the same overallScale as everything else so it shrinks proportionally during the travel animation. */
const SOCIAL_POINTS_VALID_ROUND_TEXT_OPTICAL_OFFSET_Y_WIDE = -3
const SOCIAL_POINTS_VALID_ROUND_TEXT_OPTICAL_OFFSET_Y_COMPACT = -2

/**
 * "Travel toward the counter" animation constants, VALID_ROUND only -
 * everything after the shared POP phase (which stays as-is, driven by the
 * generic phase/phaseProgress) is reinterpreted here as one continuous
 * travel: the heart drifts from its starting spot up toward the HUD row
 * (where SocialPointsCounter sits, same row/right-alignment - see
 * SocialPointsValidRoundToast's own doc comment for why this is "close
 * enough" without needing the counter's exact on-screen coordinates),
 * shrinking and fading as it goes - "this +1 is being absorbed into the
 * counter". A plain linear interpolation, no easing curves, per explicit
 * "no hace falta animación compleja" instruction.
 */
const SOCIAL_POINTS_VALID_ROUND_POP_SECONDS = 0.15 // mirrors socialPointsFeedback.ts's own POP_PHASE_SECONDS - duplicated small constant, same "sibling files, no tight coupling" convention already used elsewhere in this file (e.g. AGENDA_PINK in leaderboardUi.tsx)
const SOCIAL_POINTS_VALID_ROUND_FADE_START_FRACTION = 0.4 // opacity stays 1 for the first 40% of the travel, then fades linearly over the remaining 60%
const SOCIAL_POINTS_VALID_ROUND_TRAVEL_END_SCALE = 0.55 // size at the very end of the travel, relative to its popped size - shrinks as it "arrives"

/**
 * VALID_ROUND micro toast - a single real PNG heart with only "+1" INSIDE it
 * (absolute overlay, centered), no text beside it, no "SP" (the main
 * counter already carries that suffix - repeating it here was just noise
 * for a small, frequent reward), and no
 * uiBackground/border/capsule around it. Two animation stages, both linear
 * interpolations, no easing curves:
 *
 * 1. POP (phase === 'pop', shared timing with every other reward toast) -
 *    grows in place from 70% to 100% size, exactly as before.
 * 2. TRAVEL (everything after POP - spans what used to be the separate
 *    'hold'/'exit' phases, unified here into one continuous motion) - drifts
 *    from its starting position up toward the HUD row (same right-aligned
 *    column SocialPointsCounter sits in - see SOCIAL_POINTS_VALID_ROUND_*
 *    travel constants' own doc comment for why "the row's top edge" is used
 *    as the target rather than the counter's exact internal text position),
 *    shrinking to SOCIAL_POINTS_VALID_ROUND_TRAVEL_END_SCALE and fading out
 *    over the back 60% of that same travel - "this +1 is being absorbed
 *    into the counter".
 *
 * elapsedSeconds/totalDurationSeconds (not phase/phaseProgress) drive the
 * travel math, since it spans more than one of the generic phases -
 * SOCIAL_POINTS_VALID_ROUND_POP_SECONDS is this file's own local mirror of
 * socialPointsFeedback.ts's private POP_PHASE_SECONDS, needed only to know
 * where POP ends and TRAVEL begins.
 */
const SocialPointsValidRoundToast = ({ data, wide }: { data: ActiveSocialPointsReward; wide: boolean }) => {
    const { reward, phase, phaseProgress, elapsedSeconds, totalDurationSeconds } = data
    const anchorTop = (wide ? AGENDA_BUTTON_HIT_AREA_WIDE : AGENDA_BUTTON_HIT_AREA_COMPACT) + SOCIAL_HUD_GROUP_GAP

    const isPopping = phase === 'pop'
    const popScale = isPopping ? 0.7 + 0.3 * phaseProgress : 1

    const travelDuration = totalDurationSeconds - SOCIAL_POINTS_VALID_ROUND_POP_SECONDS
    const travelProgress = isPopping
        ? 0
        : Math.min(1, Math.max(0, (elapsedSeconds - SOCIAL_POINTS_VALID_ROUND_POP_SECONDS) / (travelDuration > 0 ? travelDuration : 1)))

    const opacity =
        travelProgress < SOCIAL_POINTS_VALID_ROUND_FADE_START_FRACTION
            ? 1
            : 1 - (travelProgress - SOCIAL_POINTS_VALID_ROUND_FADE_START_FRACTION) / (1 - SOCIAL_POINTS_VALID_ROUND_FADE_START_FRACTION)
    const travelScale = 1 - (1 - SOCIAL_POINTS_VALID_ROUND_TRAVEL_END_SCALE) * travelProgress
    const overallScale = popScale * travelScale
    // Linearly interpolates from anchorTop (starting spot, below the HUD row) to 0
    // (the row's own top edge, where the counter sits) as travelProgress goes 0->1.
    const currentTop = anchorTop * (1 - travelProgress)

    const heartSize = (wide ? SOCIAL_POINTS_VALID_ROUND_HEART_SIZE_WIDE : SOCIAL_POINTS_VALID_ROUND_HEART_SIZE_COMPACT) * overallScale
    const amountFontSize = (wide ? SOCIAL_POINTS_VALID_ROUND_AMOUNT_FONT_SIZE_WIDE : SOCIAL_POINTS_VALID_ROUND_AMOUNT_FONT_SIZE_COMPACT) * overallScale
    const opticalOffsetY = (wide ? SOCIAL_POINTS_VALID_ROUND_TEXT_OPTICAL_OFFSET_Y_WIDE : SOCIAL_POINTS_VALID_ROUND_TEXT_OPTICAL_OFFSET_Y_COMPACT) * overallScale

    return (
        <UiEntity
            uiTransform={{
                positionType: 'absolute',
                position: { top: currentTop, right: 0 },
                pointerFilter: 'none' // purely informational, must never intercept clicks meant for the HUD buttons beneath/around it
            }}
        >
            <UiEntity
                uiTransform={{ width: heartSize, height: heartSize }}
                uiBackground={{
                    texture: { src: SOCIAL_POINTS_VALID_ROUND_HEART_ICON_PATH },
                    textureMode: 'stretch',
                    color: Color4.create(1, 1, 1, opacity)
                }}
            >
                <UiEntity
                    uiTransform={{
                        positionType: 'absolute',
                        position: { top: opticalOffsetY },
                        width: '100%',
                        height: '100%',
                        justifyContent: 'center',
                        alignItems: 'center'
                    }}
                >
                    <Label value={`+${reward.amount}`} fontSize={amountFontSize} color={Color4.create(AGENDA_CREAM.r, AGENDA_CREAM.g, AGENDA_CREAM.b, opacity)} textWrap="nowrap" />
                </UiEntity>
            </UiEntity>
        </UiEntity>
    )
}

/**
 * Opens the Social Agenda overlay - one of the two buttons in the fixed HUD
 * group (see uiMenu). Its icon is the final Social Agenda PNG asset (see
 * AGENDA_BUTTON_* constants' doc comment) - the earlier provisional
 * "notebook" icon built from plain rectangles has been retired.
 *
 * A tap opens the Social Agenda directly - except during ANSWERING (which
 * also covers ANSWER LOCKED: roundManager's phase stays 'answering' for
 * both, only `selectedOption` distinguishes them), where the tap is a no-op.
 * This is deliberate: the button stays visually stable and in the same
 * place so the player never loses their sense of where it is, but can't be
 * used to cover the question or eat into response time while one is live.
 *
 * Hover/pressed/active are purely visual (see AGENDA_BUTTON_* icon-size
 * constants above), layered on top of the exact same click guard/logic
 * above, never changing what a tap does. `active` mirrors LeaderboardButton's
 * own open-state treatment in leaderboardUi.tsx, read directly from this
 * file's own socialAgendaOpen (no new plumbing needed, both live in this
 * file).
 */
const SocialAgendaButton = ({ wide }: { wide: boolean }) => {
    const hitArea = wide ? AGENDA_BUTTON_HIT_AREA_WIDE : AGENDA_BUTTON_HIT_AREA_COMPACT
    const active = socialAgendaOpen
    const iconSize = socialAgendaButtonPressed
        ? (wide ? AGENDA_BUTTON_ICON_SIZE_PRESSED_WIDE : AGENDA_BUTTON_ICON_SIZE_PRESSED_COMPACT)
        : active || socialAgendaButtonHovered
          ? (wide ? AGENDA_BUTTON_ICON_SIZE_HOVER_WIDE : AGENDA_BUTTON_ICON_SIZE_HOVER_COMPACT)
          : (wide ? AGENDA_BUTTON_ICON_SIZE_WIDE : AGENDA_BUTTON_ICON_SIZE_COMPACT)
    const unseenCount = getUnseenConnectionCount()
    const badgeText = unseenCount > AGENDA_BADGE_MAX_DISPLAY ? `${AGENDA_BADGE_MAX_DISPLAY}+` : `${unseenCount}`
    const badgeSize = wide ? AGENDA_BADGE_SIZE_WIDE : AGENDA_BADGE_SIZE_COMPACT
    const badgeOffset = wide ? AGENDA_BADGE_OFFSET_WIDE : AGENDA_BADGE_OFFSET_COMPACT

    return (
        <UiEntity
            uiTransform={{
                width: hitArea,
                height: hitArea,
                justifyContent: 'center',
                alignItems: 'center'
            }}
            onMouseEnter={() => (socialAgendaButtonHovered = true)}
            onMouseLeave={() => {
                socialAgendaButtonHovered = false
                socialAgendaButtonPressed = false // dragging off mid-press shouldn't leave it stuck pressed
            }}
            onMouseDown={() => {
                socialAgendaButtonPressed = true
                // Covers ANSWER LOCKED and the pre-round COUNTDOWN too - see doc comment above.
                const phase = roundManager.getSnapshot().phase
                if (phase === 'answering' || phase === 'countdown') return
                socialAgendaPage = 0
                socialAgendaOpen = true
                closeLeaderboard() // mutually exclusive centered overlays - see isLeaderboardOpen's own doc comment
                // Reveal-on-open (see revealUnseenConnections' own doc comment). Gated on
                // hydration being READY - if it isn't yet, Agenda still opens normally
                // (never blocked on Storage); uiMenu's own per-frame check reveals
                // whatever hydration brings in the moment it lands, still within this
                // same opening.
                if (isNotificationsHydrated()) {
                    notificationsHydratedSeenLocally = true
                    revealUnseenConnections(getUnseenConnectionIds())
                }
            }}
            onMouseUp={() => (socialAgendaButtonPressed = false)}
        >
            <UiEntity
                uiTransform={{ width: iconSize, height: iconSize }}
                uiBackground={{ texture: { src: SOCIAL_AGENDA_ICON_PATH }, textureMode: 'stretch' }}
            />
            {unseenCount > 0 && (
                <UiEntity
                    uiTransform={{
                        positionType: 'absolute',
                        position: { top: badgeOffset, right: badgeOffset },
                        width: badgeSize,
                        height: badgeSize,
                        borderRadius: badgeSize / 2,
                        borderWidth: 1,
                        borderColor: AGENDA_CREAM,
                        justifyContent: 'center',
                        alignItems: 'center',
                        pointerFilter: 'none' // never intercepts the tap - the button's own hit area handles it, see doc comment above
                    }}
                    uiBackground={{ color: AGENDA_BADGE_BACKGROUND }}
                >
                    <Label value={badgeText} fontSize={wide ? AGENDA_BADGE_FONT_SIZE_WIDE : AGENDA_BADGE_FONT_SIZE_COMPACT} color={AGENDA_CREAM} />
                </UiEntity>
            )}
        </UiEntity>
    )
}

/**
 * Presentation-only threshold on top of compatibilityManager's pure
 * getCompatibility()/getSharedValidAnswers() - the core stays a plain
 * null-or-percentage calculation with no concept of "too little data to
 * show a number yet"; that judgment call belongs here, in the one place
 * that renders it. A real percentage only appears at 5+ shared valid
 * answers - below that, a single shared question could read as a
 * misleadingly solid 100%/0%.
 */
const AFFINITY_MIN_SHARED_ANSWERS = 5

/**
 * Same three states/thresholds as before (0 / <5 / 5+ shared valid answers),
 * same getCompatibility/getSharedValidAnswers calls, same Math.round - this
 * is a presentation-only reshape, not a logic change. Previously returned one
 * fused string; now splits the 5+ case into `primary` (the affinity
 * percentage, shown in pink) and `secondary` (the shared-answer count, shown
 * muted) so the Agenda row can color them differently - see SocialAgenda's
 * own row rendering. The two below-threshold states have no secondary line
 * of their own (`secondary: null`) - they're each a single deliberate
 * statement, not a percentage-plus-count pair.
 */
interface AffinityPresentation {
    primary: string
    secondary: string | null
}

function affinityLabel(sameAnswers: number, differentAnswers: number): AffinityPresentation {
    const shared = getSharedValidAnswers(sameAnswers, differentAnswers)
    if (shared === 0) return { primary: 'NO AFFINITY DATA', secondary: null }
    if (shared < AFFINITY_MIN_SHARED_ANSWERS) return { primary: 'GETTING TO KNOW EACH OTHER...', secondary: null }
    const compatibility = getCompatibility(sameAnswers, differentAnswers) as number // non-null: shared > 0 here
    return { primary: `${Math.round(compatibility)}% AFFINITY`, secondary: `${shared} SHARED ANSWER${shared === 1 ? '' : 'S'}` }
}

/**
 * Full-list overlay - opened via SocialAgendaButton (see uiMenu). Reads
 * connectionsManager's existing getAllConnections()
 * directly - no second list of
 * relationships, no new Connection state. Ordering is whatever getAllConnections()
 * already returns: Map insertion order, i.e. the order each partner was first met
 * in, oldest-first - a genuinely stable, deterministic order with no invented
 * recency/ranking system layered on top (see report). Friendship level is the same
 * pure getFriendshipLevel(roundsTogether) lookup used everywhere else - no
 * threshold logic duplicated here. Paginated rather than scrolled - see
 * AGENDA_ROWS_PER_PAGE's comment for why.
 */
const SocialAgenda = ({ wide, compactUi }: { wide: boolean; compactUi: boolean }) => {
    const allConnections = getAllConnections()
    const totalPages = Math.max(1, Math.ceil(allConnections.length / AGENDA_ROWS_PER_PAGE))
    const pageStart = socialAgendaPage * AGENDA_ROWS_PER_PAGE
    const pageEntries = allConnections.slice(pageStart, pageStart + AGENDA_ROWS_PER_PAGE)
    const canGoPrevious = socialAgendaPage > 0
    const canGoNext = socialAgendaPage < totalPages - 1

    /**
     * Panel WIDTH/height-cap uses `isMobile()` directly - NOT the `compactUi`
     * prop (isMobile() || !wide) - deliberately different from every other
     * use of `compactUi` in this component (row typography still uses it,
     * unchanged). `compactUi` goes true on ANY narrow canvas, including a
     * small desktop preview window - that's correct for "should this text be
     * smaller," but wrong for "should this panel switch to a percentage-of-
     * screen width," which should only ever happen on an actual phone.
     * leaderboardUi.tsx's own panel has no percentage-width branch at all -
     * it's ALWAYS a fixed AGENDA_WIDTH_WIDE/COMPACT-equivalent pixel value,
     * on every platform - and this now matches that same criterion for every
     * non-mobile viewport, however narrow. MOBILE_AGENDA_WIDTH/MAX_HEIGHT are
     * only reached on a confirmed real device.
     */
    const isRealMobileDevice = isMobile()

    const close = () => {
        socialAgendaOpen = false
    }

    return (
        <UiEntity
            uiTransform={
                isRealMobileDevice
                    ? { flexDirection: 'column', width: MOBILE_AGENDA_WIDTH, maxHeight: MOBILE_AGENDA_MAX_HEIGHT, borderRadius: AGENDA_PANEL_BORDER_RADIUS }
                    : {
                          flexDirection: 'column',
                          width: wide ? AGENDA_WIDTH_WIDE : AGENDA_WIDTH_COMPACT,
                          borderRadius: AGENDA_PANEL_BORDER_RADIUS
                      }
            }
            uiBackground={{ color: PANEL_BACKGROUND }}
        >
            {/* Header is the whole-row tap target to close - generous padding (not just the "✕"
                glyph). This is the only close control now; no footer bar (see report). Top corners match the panel's own
                radius so this opaque rectangle doesn't square off the panel's rounded top -
                same technique as leaderboardUi.tsx's own header. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: { top: 18, bottom: 18, left: 20, right: 20 },
                    borderRadius: AGENDA_HEADER_BORDER_RADIUS
                }}
                uiBackground={{ color: PANEL_BACKGROUND }}
                onMouseDown={close}
            >
                {/* "SOCIAL AGENDA" - renamed from "MY SOCIAL QUEST" so this panel and
                    leaderboardUi.tsx's "LEADERBOARD" read as two sibling tools sharing one
                    naming convention, same star-accent treatment as that header. */}
                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Label value="✦" fontSize={18} color={AGENDA_PINK} />
                    <UiEntity uiTransform={{ width: 10 }} />
                    <Label value="SOCIAL AGENDA" fontSize={22} color={AGENDA_CREAM} />
                </UiEntity>
                <Label value="✕" fontSize={22} color={AGENDA_PINK} />
            </UiEntity>

            <UiEntity
                uiTransform={{
                    flexDirection: 'column',
                    width: '100%',
                    minHeight: isRealMobileDevice ? undefined : wide ? AGENDA_CONTENT_MIN_HEIGHT_WIDE : AGENDA_CONTENT_MIN_HEIGHT_COMPACT,
                    padding: { top: 16, bottom: 20, left: 20, right: 20 }
                }}
            >
                {allConnections.length === 0 ? (
                    <UiEntity uiTransform={COLUMN_CENTERED}>
                        {/* Copy unchanged from the already-shipped empty state - only color changed (cream/muted, matching the rest of this redesign). */}
                        <Label value="No Connections yet." fontSize={20} color={AGENDA_CREAM} uiTransform={{ margin: { bottom: 8 } }} />
                        <Label
                            value="Play Social Quest with someone to make your first Connection."
                            fontSize={16}
                            color={MUTED}
                            textAlign="middle-center"
                            textWrap="wrap"
                        />
                    </UiEntity>
                ) : (
                    <UiEntity uiTransform={{ flexDirection: 'column', width: '100%' }}>
                        <Label
                            value={`${allConnections.length} CONNECTION${allConnections.length === 1 ? '' : 'S'}`}
                            fontSize={AGENDA_COUNT_FONT_SIZE}
                            color={MUTED}
                            uiTransform={{ margin: { bottom: 14 } }}
                        />
                        {/* REVEAL banner - scoped to THIS opening only (agendaRevealedConnectionIds
                            is reset to [] the moment Agenda closes, see uiMenu's own per-frame
                            check), never persisted. Same display-name resolution priority as each
                            row below (a currently-observable name wins over the persisted one,
                            which wins over the generic fallback) - no extra profile requests, just
                            the data this panel already has. Names beyond MAX_CELEBRATION_NAMES
                            collapse into "+N more" (own join here - the HUD toasts above no longer
                            list multiple names at all, so there's nothing shared to reuse). Visual
                            treatment deliberately simple/placeholder - a
                            bordered box in the panel's own existing palette, not yet the
                            nine-slice/sticker polish planned for a later pass. */}
                        {agendaRevealedConnectionIds.length > 0 &&
                            (() => {
                                const revealedNames = agendaRevealedConnectionIds.map((otherUserId) => {
                                    const connection = allConnections.find((c) => c.otherUserId.toLowerCase() === otherUserId)
                                    return getDisplayNameFor(otherUserId) ?? connection?.lastKnownDisplayName ?? QUESTMATE_FALLBACK
                                })
                                const shownNames = revealedNames.slice(0, MAX_CELEBRATION_NAMES)
                                const remainingNames = revealedNames.length - shownNames.length
                                const namesText = remainingNames > 0 ? `${shownNames.join(', ')} +${remainingNames} more` : shownNames.join(', ')
                                const headerText =
                                    agendaRevealedConnectionIds.length === 1 ? 'NEW CONNECTION!' : `${agendaRevealedConnectionIds.length} NEW CONNECTIONS!`
                                return (
                                    <UiEntity
                                        uiTransform={{
                                            width: '100%',
                                            flexDirection: 'column',
                                            padding: { top: 12, bottom: 12, left: 16, right: 16 },
                                            margin: { bottom: 14 },
                                            borderRadius: 12,
                                            borderWidth: 1,
                                            borderColor: AGENDA_PINK
                                        }}
                                        uiBackground={{ color: PANEL_BACKGROUND }}
                                    >
                                        <Label value={headerText} fontSize={wide ? 18 : 15} color={AGENDA_PINK} />
                                        <Label
                                            value={`${namesText} joined your Social Agenda`}
                                            fontSize={wide ? 15 : 13}
                                            color={AGENDA_CREAM}
                                            textWrap="wrap"
                                            uiTransform={{ margin: { top: 4 } }}
                                        />
                                    </UiEntity>
                                )
                            })()}
                        {pageEntries.map((connection, index) => {
                            // Priority: a currently-observable name always wins over a persisted
                            // one (which may be stale), which in turn wins over the generic fallback.
                            const name = getDisplayNameFor(connection.otherUserId) ?? connection.lastKnownDisplayName ?? QUESTMATE_FALLBACK
                            // Purely visual - never touches ConnectionRecord. Normalized the same
                            // way socialNotificationsManager's ids already are (lowercase), since
                            // otherUserId here is the raw, case-preserved address.
                            const isNewRow = agendaRevealedConnectionIds.includes(connection.otherUserId.toLowerCase())
                            const level = getFriendshipLevel(connection.roundsTogether)
                            const affinity = affinityLabel(connection.sameAnswers, connection.differentAnswers)
                            const nameFontSize = compactUi ? AGENDA_NAME_FONT_SIZE_COMPACT : AGENDA_NAME_FONT_SIZE_WIDE
                            const secondaryFontSize = compactUi ? AGENDA_SECONDARY_FONT_SIZE_COMPACT : AGENDA_SECONDARY_FONT_SIZE_WIDE
                            const tertiaryFontSize = compactUi ? AGENDA_TERTIARY_FONT_SIZE_COMPACT : AGENDA_TERTIARY_FONT_SIZE_WIDE
                            const isLastOnPage = index === pageEntries.length - 1
                            const avatarSize = compactUi ? AGENDA_AVATAR_SIZE_COMPACT : AGENDA_AVATAR_SIZE_WIDE
                            const avatarGap = compactUi ? AGENDA_AVATAR_GAP_COMPACT : AGENDA_AVATAR_GAP_WIDE
                            // Kicks off resolution once per userId (safe to call every render - see
                            // profilePictureManager.ts's own doc comment on why the cache itself is the
                            // dedup guard) and reads back whatever is currently known. Works offline -
                            // this hits the catalyst directly by address, never getPlayer(), so a
                            // Connection who isn't currently in the scene still resolves.
                            requestProfilePicture(connection.otherUserId)
                            const pictureUrl = getProfilePictureUrl(connection.otherUserId)
                            return (
                                <UiEntity key={connection.otherUserId} uiTransform={{ width: '100%', flexDirection: 'column' }}>
                                    <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center' }}>
                                        {/* Real DCL profile picture (catalyst snapshots.face256, resolved by
                                            profilePictureManager.ts - NOT uiBackground.avatarTexture, which
                                            was tried first and rejected: its crop is too tight, showing only
                                            eyes/nose/glasses). Circular medallion, OPTION B (confirmed
                                            necessary - OPTION A, borderRadius directly on the textured
                                            entity, was tried and visually confirmed to NOT clip the
                                            texture): an OUTER ring entity owns the cream border + borderRadius
                                            + `overflow:'hidden'` (both real UiTransformProps fields - no
                                            `mask`/`clip-path` exists in this SDK, confirmed absent from its
                                            own typings), and a separate INNER entity filling 100% of it
                                            carries either the resolved photo or a fallback silhouette - the
                                            inner square content gets clipped to the outer's rounded shape via
                                            that overflow:hidden. The inner also repeats borderRadius as a
                                            defensive belt-and-suspenders measure, in case this renderer's
                                            clip check looks at the clipped child's own shape rather than
                                            only the parent's. */}
                                        <UiEntity
                                            uiTransform={{
                                                width: avatarSize,
                                                height: avatarSize,
                                                borderRadius: avatarSize / 2,
                                                borderWidth: AGENDA_AVATAR_BORDER_WIDTH,
                                                borderColor: AGENDA_CREAM,
                                                overflow: 'hidden',
                                                flexShrink: 0
                                            }}
                                        >
                                            {pictureUrl ? (
                                                <UiEntity
                                                    uiTransform={{ width: '100%', height: '100%', borderRadius: avatarSize / 2 }}
                                                    uiBackground={{ texture: { src: pictureUrl }, textureMode: 'stretch' }}
                                                />
                                            ) : (
                                                // Fallback while loading/missing/failed - a single generic
                                                // silhouette (head + shoulders) built from plain colored
                                                // UiEntity shapes, never avatarTexture (its tight crop is the
                                                // exact problem this feature was built to avoid).
                                                <UiEntity
                                                    uiTransform={{
                                                        width: '100%',
                                                        height: '100%',
                                                        borderRadius: avatarSize / 2,
                                                        flexDirection: 'column',
                                                        alignItems: 'center',
                                                        justifyContent: 'flex-end'
                                                    }}
                                                    uiBackground={{ color: AGENDA_AVATAR_FALLBACK_BACKGROUND }}
                                                >
                                                    <UiEntity
                                                        uiTransform={{
                                                            width: avatarSize * 0.42,
                                                            height: avatarSize * 0.42,
                                                            borderRadius: (avatarSize * 0.42) / 2,
                                                            margin: { bottom: avatarSize * 0.05 }
                                                        }}
                                                        uiBackground={{ color: AGENDA_CREAM }}
                                                    />
                                                    <UiEntity
                                                        uiTransform={{ width: avatarSize * 0.78, height: avatarSize * 0.55, borderRadius: avatarSize * 0.4 }}
                                                        uiBackground={{ color: AGENDA_CREAM }}
                                                    />
                                                </UiEntity>
                                            )}
                                        </UiEntity>
                                        <UiEntity uiTransform={{ width: avatarGap }} />
                                        <UiEntity uiTransform={{ flexDirection: 'column', flexGrow: 1 }}>
                                            {/* Line 1: name - the row's own primary element, cream, largest weight - plus
                                                a small NEW tag, purely visual, only while this Connection is part of
                                                THIS Agenda opening's reveal (see agendaRevealedConnectionIds' own doc
                                                comment) - gone on the very next opening. */}
                                            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                                                <Label value={name} fontSize={nameFontSize} color={AGENDA_CREAM} />
                                                {isNewRow && (
                                                    <UiEntity
                                                        uiTransform={{ margin: { left: 8 }, padding: { top: 2, bottom: 2, left: 6, right: 6 }, borderRadius: 6 }}
                                                        uiBackground={{ color: AGENDA_PINK }}
                                                    >
                                                        <Label value="NEW" fontSize={compactUi ? 10 : 11} color={PANEL_BACKGROUND} />
                                                    </UiEntity>
                                                )}
                                            </UiEntity>
                                            {/* Line 2: affinity (pink, primary) + shared answers (muted, secondary),
                                                a discreet " · " separator between them only when both exist - the
                                                two below-threshold states (NO AFFINITY DATA / GETTING TO KNOW EACH
                                                OTHER...) are single deliberate statements with no count to pair
                                                with, shown muted rather than pink so they read as calm/expected,
                                                never like an error. */}
                                            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: 4 } }}>
                                                <Label value={affinity.primary} fontSize={secondaryFontSize} color={affinity.secondary ? AGENDA_PINK : MUTED} textWrap="wrap" />
                                                {affinity.secondary && (
                                                    <Label value={` · ${affinity.secondary}`} fontSize={secondaryFontSize} color={MUTED} textWrap="wrap" />
                                                )}
                                            </UiEntity>
                                            {/* Line 3: Friendship level (teal, its own bit of personality) +
                                                rounds together (muted) - only once a level exists at all (a
                                                brand new Connection has none yet, same as before). */}
                                            {level !== null && (
                                                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: 4 } }}>
                                                    <Label value={`✦ ${level}`} fontSize={tertiaryFontSize} color={AGENDA_TEAL} textWrap="wrap" />
                                                    <Label value=" · " fontSize={tertiaryFontSize} color={MUTED} />
                                                    <Label
                                                        value={`${connection.roundsTogether} ROUND${connection.roundsTogether === 1 ? '' : 'S'}`}
                                                        fontSize={tertiaryFontSize}
                                                        color={MUTED}
                                                        textWrap="wrap"
                                                    />
                                                </UiEntity>
                                            )}
                                        </UiEntity>
                                    </UiEntity>
                                    {/* Very faint divider between connections - see AGENDA_ROW_DIVIDER_COLOR's
                                        own doc comment. Skipped after the last row on this page so nothing
                                        stray sits directly above the pagination footer. */}
                                    {!isLastOnPage && (
                                        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { top: 12, bottom: 12 } }} uiBackground={{ color: AGENDA_ROW_DIVIDER_COLOR }} />
                                    )}
                                </UiEntity>
                            )
                        })}

                        {totalPages > 1 && (
                            <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', margin: { top: 8 } }}>
                                <UiEntity
                                    uiTransform={{ padding: { top: 8, bottom: 8, left: 14, right: 14 }, borderRadius: 8 }}
                                    uiBackground={{ color: PANEL_BACKGROUND }}
                                    onMouseDown={() => {
                                        if (canGoPrevious) socialAgendaPage -= 1
                                    }}
                                >
                                    <Label value="PREV" fontSize={14} color={canGoPrevious ? AGENDA_CREAM : MUTED} />
                                </UiEntity>
                                <Label value={`${socialAgendaPage + 1} / ${totalPages}`} fontSize={14} color={MUTED} />
                                <UiEntity
                                    uiTransform={{ padding: { top: 8, bottom: 8, left: 14, right: 14 }, borderRadius: 8 }}
                                    uiBackground={{ color: PANEL_BACKGROUND }}
                                    onMouseDown={() => {
                                        if (canGoNext) socialAgendaPage += 1
                                    }}
                                >
                                    <Label value="NEXT" fontSize={14} color={canGoNext ? AGENDA_CREAM : MUTED} />
                                </UiEntity>
                            </UiEntity>
                        )}
                    </UiEntity>
                )}
            </UiEntity>
        </UiEntity>
    )
}

/**
 * NEW_CONNECTION's own Social Points bonus, resolved from FRIENDSHIP_LEVELS
 * by its stable id (never a hardcoded 25) and multiplied by how many new
 * partners this celebration actually covers - each one individually crosses
 * the NEW_CONNECTION milestone (see friendshipManager.ts's own "first
 * observation" rule), so N simultaneous new Connections means N times the
 * bonus, matching exactly what socialPointsFeedback.ts's counter already
 * adds (one queueReward() call per crossing - see tickFriendshipBonus). This
 * NEW_CONNECTION milestone never emits a FriendshipLevelUpEvent of its own
 * (by design - see friendshipManager.ts), so a real PresentedNewConnectionCelebration
 * firing at all IS the signal, rather than a field on the event itself.
 */
function resolveNewConnectionBonusAmount(newConnectionCount: number): number {
    const definition = FRIENDSHIP_LEVELS.find((level) => level.id === 'NEW_CONNECTION')
    return (definition?.bonusPoints ?? 0) * newConnectionCount
}

/**
 * Single-line toast for a NEW CONNECTION, shown in the right slot of the upper
 * social row (see uiMenu). TITLE / name (singular only) / BONUS SP hierarchy:
 * exactly 1 new partner names them (the detail Social Agenda already covers
 * in full), 2+ collapses straight to a count - never lists multiple names, so
 * the toast can't grow long or wide with a big group. Purely a renderer of
 * the data it's given; builds no relationship/queue logic of its own.
 */
const NewConnectionToast = ({ data }: { data: PresentedNewConnectionCelebration }) => {
    const count = data.newUserIds.length
    const titleText = count === 1 ? 'NEW CONNECTION!' : `${count} NEW CONNECTIONS!`
    const nameText = count === 1 ? getDisplayNameFor(data.newUserIds[0]) ?? QUESTMATE_FALLBACK : null
    const bonusAmount = resolveNewConnectionBonusAmount(count)

    return (
        <UiEntity
            uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: { top: 10, bottom: 10, left: 16, right: 16 } }}
            uiBackground={{ color: Color4.create(0.35, 0.08, 0.25, 0.92) }}
        >
            <Label value={titleText} fontSize={18} color={Color4.White()} textAlign="middle-center" textWrap="nowrap" />
            {nameText !== null && (
                <Label
                    value={nameText}
                    fontSize={14}
                    color={MUTED}
                    textAlign="middle-center"
                    textWrap="nowrap"
                    uiTransform={{ margin: { top: 2 } }}
                />
            )}
            <Label value={`+${bonusAmount} SP`} fontSize={15} color={AGENDA_TEAL} textAlign="middle-center" uiTransform={{ margin: { top: 4 } }} />
        </UiEntity>
    )
}

/**
 * Single-line toast for a FRIENDSHIP LEVEL UP. Same TITLE / name-or-summary /
 * BONUS SP hierarchy as NewConnectionToast above: exactly 1 partner at this
 * level names them, 2+ AT THE SAME level collapses to a short count summary -
 * never lists multiple names. The bonus is resolved from FRIENDSHIP_LEVELS by
 * `data.level` (never a hardcoded number) and multiplied by how many partners
 * reached that SAME level this tick, matching exactly what
 * socialPointsFeedback.ts's counter already added (one queueReward() call per
 * crossing).
 *
 * `data.level` is `null` when several partners crossed DIFFERENT levels in
 * the same tick (see friendshipCelebration.ts's own buildSnapshot doc
 * comment) - there is no single resolvable level, name, or bonus amount in
 * that case (each partner earned something different), so this keeps the
 * existing generic "LEVEL UP" title only, with no name and no SP line rather
 * than inventing any of the three. A known, accepted limitation of the
 * current celebration payload, not solved in this pass.
 */
const FriendshipToast = ({ data }: { data: PresentedFriendshipCelebration }) => {
    if (data.level === null) {
        return (
            <UiEntity
                uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: { top: 10, bottom: 10, left: 16, right: 16 } }}
                uiBackground={{ color: Color4.create(0.08, 0.2, 0.35, 0.92) }}
            >
                <Label value="LEVEL UP!" fontSize={18} color={Color4.White()} textAlign="middle-center" textWrap="nowrap" />
            </UiEntity>
        )
    }

    const count = data.userIds.length
    const titleText = `${data.level}!`
    const nameText = count === 1 ? getDisplayNameFor(data.userIds[0]) ?? QUESTMATE_FALLBACK : `${count} CONNECTIONS LEVELED UP`
    const levelDefinition = FRIENDSHIP_LEVELS.find((level) => level.level === data.level)
    const bonusAmount = levelDefinition ? levelDefinition.bonusPoints * count : null

    return (
        <UiEntity
            uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: { top: 10, bottom: 10, left: 16, right: 16 } }}
            uiBackground={{ color: Color4.create(0.08, 0.2, 0.35, 0.92) }}
        >
            <Label value={titleText} fontSize={18} color={Color4.White()} textAlign="middle-center" textWrap="nowrap" />
            <Label value={nameText} fontSize={14} color={MUTED} textAlign="middle-center" textWrap="nowrap" uiTransform={{ margin: { top: 2 } }} />
            {bonusAmount !== null && (
                <Label value={`+${bonusAmount} SP`} fontSize={15} color={AGENDA_TEAL} textAlign="middle-center" uiTransform={{ margin: { top: 4 } }} />
            )}
        </UiEntity>
    )
}
