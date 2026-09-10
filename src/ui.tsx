import ReactEcs, { Label, ReactEcsRenderer, ScreenInsetArea, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { myProfile } from '@dcl/sdk/network'
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
import { getFriendshipLevel, FRIENDSHIP_LEVELS, FriendshipMilestoneId } from './friendshipManager'
import { getCompatibility, getSharedValidAnswers } from './compatibilityManager'
import {
    getPresentedCelebration,
    PresentedSocialCelebration,
    PresentedNewConnectionCelebration,
    PresentedFriendshipCelebration
} from './socialCelebrationQueue'
import { CELEBRATION_TICKS as NEW_CONNECTION_CELEBRATION_TICKS } from './connectionCelebration'
import { CELEBRATION_TICKS as FRIENDSHIP_CELEBRATION_TICKS } from './friendshipCelebration'
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
    // Own independent pop/hold/exit accumulator for celebration cards - same
    // architecture as socialPointsFeedback.ts's engine.addSystem for
    // SocialPointsValidRoundToast, kept entirely in this file (see
    // tickCelebrationPresentation's own doc comment). Never touches
    // socialCelebrationQueue.ts/connectionCelebration.ts/friendshipCelebration.ts.
    engine.addSystem(tickCelebrationPresentation)
    // Own independent entrance-fade accumulator for the RESULT reveal - same
    // pattern as tickCelebrationPresentation above, kept entirely in this file
    // (see tickResultRevealPresentation's own doc comment). Never touches
    // roundManager.ts/RESULT_SECONDS/REVEAL_TIMEOUT_SECONDS.
    engine.addSystem(tickResultRevealPresentation)
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
 * a module. Originally used only by Social Agenda; since reused for the
 * celebration cards and the main gameplay panel's own text once both moved
 * onto cream/pastel backgrounds - the one shared Social Quest palette this
 * whole file has been converging on, not a Social-Agenda-only set anymore.
 */
const AGENDA_CREAM = Color4.create(0.97, 0.93, 0.86, 1)
const AGENDA_PINK = Color4.create(1, 0.75, 0.9, 1)
const AGENDA_TEAL = Color4.create(0.4, 0.75, 1, 1)
/**
 * Dark, desaturated plum - the on-cream counterpart to MUTED (which is a
 * light gray built for dark backgrounds, e.g. ResultColumn's own dark cards,
 * the Agenda panel, the HUD - all untouched, still correct there). Added
 * specifically for secondary/auxiliary text that now sits directly on the
 * new pastel gameplay panel background (see the panel background's own doc
 * comment): no existing constant already provided adequate contrast there,
 * MUTED itself included (0.7,0.7,0.75 reads as near-invisible on the new
 * cream backdrop).
 */
const CREAM_PANEL_TEXT_MUTED = Color4.create(0.45, 0.32, 0.4, 1)

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
 * Hover state for the two ANSWERING option buttons and the JOIN button -
 * presentation-only, same pattern as socialAgendaButtonHovered above, never
 * read by roundManager/selectOption. These buttons mount/unmount across
 * rounds (the answer buttons disappear once locked; JoinScreen disappears
 * once joined), and an onMouseLeave isn't guaranteed to fire on unmount, so
 * JoinedGameplay force-resets both answer flags on every render where the
 * buttons aren't shown, and forces joinButtonHovered false on every render
 * (it's only ever shown pre-join) - see the reset lines in JoinScreen/
 * JoinedGameplay for where that happens.
 */
let answerOptionAHovered = false
let answerOptionBHovered = false
let joinButtonHovered = false

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

/**
 * Mobile-only (isMobile() real device, never a small desktop preview window -
 * same isRealMobileDevice signal as SocialAgenda's own, computed once in
 * uiMenu and reused for the HUD row + the questions panel below) right-edge
 * inset for the relocated top-right HUD cluster. Desktop keeps the existing
 * centered two-slot row entirely untouched - see uiMenu's own isRealMobileDevice
 * branch for both JSX paths.
 *
 * History: 16 -> 6 (first nudge right) was not enough - Social Agenda's own
 * baked-in top decoration (see SOCIAL_AGENDA_PANEL_PATH, a centered overlay)
 * was still partially covering the Agenda icon when opened. Now 6 -> -44 (a
 * further ~50px shift right) per explicit feedback that a clearly bigger move
 * was needed. This SDK's UiTransform has no separate transform/translate
 * primitive (confirmed absent from this session's own typings audits) - a
 * `position.right` offset IS the only mechanism available for nudging an
 * absolutely-positioned entity, so going negative here (pushing the cluster
 * past ScreenInsetArea's own safe-area inset, toward the true screen edge) is
 * that "offset/translate on the whole container," not a different technique.
 * `top`, icon sizes (HUD_MOBILE_ICON_SCALE), SOCIAL_HUD_GROUP_GAP, and the SP
 * counter's own size are all completely untouched - only this one offset
 * changed, so the group moves as a single rigid unit. Real-device
 * confirmation still pending (this task's own next step) - if the SP counter
 * turns out to clip the true screen edge, this needs to come back up
 * slightly, not further negative.
 *
 * History: -44 was still not enough - Social Agenda's own centered overlay
 * (see SOCIAL_AGENDA_PANEL_PATH) was still catching the Agenda icon's corner
 * when opened. Nudged another 20px right, -44 -> -64. Same mechanism, same
 * caveat: if this clips the SP counter off the real screen edge, come back
 * up (less negative), never push further negative blindly.
 */
const HUD_MOBILE_RIGHT_MARGIN = -64

/**
 * Conservative mobile-only shrink factor for the "questions panel" (the
 * decorative SOCIAL_QUEST_PANEL_BACKGROUND image plus its inner
 * GAMEPLAY_PANEL / WAITING_PANEL / LOBBY_PANEL_HEIGHT content box) - per
 * explicit feedback that this panel is too large on a real phone screen.
 * Applied uniformly to both the outer background (height-driven, aspect-ratio
 * preserved automatically - see getSocialQuestPanelBackgroundSize) and the
 * inner content box's own width/height, so the existing fit between the two
 * (already correct at every WIDE/COMPACT tier today) is preserved exactly,
 * just at a smaller absolute scale. Gated on isMobile() alone, never
 * `compact` - a narrow desktop preview window must keep today's COMPACT size.
 * Bumped 0.72 -> 0.82 per real-device feedback that the first mobile pass
 * shrank this panel too far.
 */
const GAMEPLAY_MOBILE_SCALE = 0.82

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
 * Mobile-only (isMobile() real device) icon-size multiplier for the HUD's
 * Agenda/Leaderboard icons - per explicit "12% bigger, balanced" feedback.
 * Applied as a post-multiply on whatever idle/hover/pressed size the existing
 * wide/compact tiers already compute (SocialAgendaButton here, and
 * LeaderboardButton's own identical LEADERBOARD_BUTTON_ICON_SIZE_* in
 * leaderboardUi.tsx - same constant value duplicated there, same "sibling
 * surfaces" precedent already used for those two constant blocks). Never
 * touches AGENDA_BUTTON_HIT_AREA_* (the invisible tap target) - COMPACT's
 * hit area (64) still comfortably contains even the largest scaled icon
 * (HOVER: 56*1.12=62.72), so no separate hit-area change was needed. Desktop
 * (`wide`, non-mobile compact) is completely unaffected - this only ever
 * multiplies when isMobile() is true.
 */
const HUD_MOBILE_ICON_SCALE = 1.12

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
 * Illustrated "open notebook" background replacing the old flat dark panel -
 * SOCIAL AGENDA title, rings, tabs, and the "Friends" note are all baked into
 * this PNG (1192x1320, RGBA, aspect ratio 1192/1320 = 0.9030). textureMode
 * 'stretch' + box dimensions matching this exact ratio, same technique as
 * every other background asset in this file (gameplay/lobby panel, celebration
 * tiers) - never deformed.
 *
 * Sizing derivation (see this task's report for the full pixel-sampled
 * measurement): the illustrated asset's decoration (rings/tabs/header/bottom
 * flower cluster) eats far more of the interior than the flat old panel did -
 * a pixel-sampled scan (pngjs) of where the cream page is simultaneously free
 * of ALL four decorations found a safe rectangle of only ~64% width x ~56%
 * height of the full image (see AGENDA_SAFE_AREA_* below), well short of the
 * "85-90%" a generic illustrated-panel estimate would assume. The panel is a
 * FIXED width+height (matching the image 1:1), not an auto-growing minHeight
 * box like the old flat panel - the illustrated frame doesn't resize itself
 * to content, so a shorter page just leaves clean empty cream space at the
 * bottom of the fixed safe area instead.
 *
 * WIDE was first set to 920x1019 (meets the old flat panel's 560 content-
 * height floor with margin inside the measured ~56%-height safe area), then
 * brought down to this smaller AGENDA_PANEL_WIDTH_WIDE/HEIGHT_WIDE per
 * explicit follow-up feedback that 920x1019 read as too large on a full
 * screen - a deliberate, requested trade: at 760x842 the safe area's real
 * height budget (~842*0.56 = ~471) sits below that same 560 floor, so the
 * absolute worst case (all 6 rows showing a reached friendship level, WIDE's
 * larger row typography) has less slack than before and should be re-checked
 * visually; COMPACT (already at this exact 760x842 pixel size before this
 * change, since it targeted the smaller COMPACT floor of 460) is untouched.
 */
const SOCIAL_AGENDA_PANEL_PATH = 'assets/images/social-agenda-panel.png'
const SOCIAL_AGENDA_PANEL_ASPECT_RATIO = 1192 / 1320
const AGENDA_PANEL_WIDTH_WIDE = 760
const AGENDA_PANEL_HEIGHT_WIDE = 842
const AGENDA_PANEL_WIDTH_COMPACT = 760
const AGENDA_PANEL_HEIGHT_COMPACT = 842

/**
 * Safe area for dynamic content - the pixel-sampled cream rectangle described
 * above, expressed as percentages of the panel (so it scales identically
 * across WIDE/COMPACT/mobile without re-measuring). Positioned/sized as an
 * absolute box inside the panel, same pattern as the gameplay panel's own
 * safe area (see SOCIAL_QUEST_PANEL_BACKGROUND_SAFE_AREA_*), except this one
 * needs all four edges (left/top/width/height) rather than just top/height,
 * since this asset has decoration on every side (rings left, tabs right,
 * header top, flowers bottom) rather than only top/bottom.
 */
const AGENDA_SAFE_AREA_LEFT_PERCENT = '20%'
const AGENDA_SAFE_AREA_TOP_PERCENT = '24%'
const AGENDA_SAFE_AREA_WIDTH_PERCENT = '63%'
const AGENDA_SAFE_AREA_HEIGHT_PERCENT = '56%'

/**
 * Real-mobile-device sizing (isRealMobileDevice, i.e. bare isMobile() - see
 * SocialAgenda's own doc comment on why this is a different signal than
 * `compactUi`). Computed from the SDK-reported live canvas size
 * (UiCanvasInformation, same source getUiScale() itself reads) rather than a
 * bare percentage string: this panel is now a background IMAGE that must
 * never deform, and a plain CSS-style `width:'65%'` + `maxHeight:'70%'` pair
 * (the previous approach, fine for an auto-height content box) does NOT
 * preserve a fixed image aspect ratio - this SDK's UiTransform has no
 * `aspectRatio` field (confirmed absent from its own typings) to do that
 * declaratively. getMobileAgendaPanelSize() below instead computes an exact
 * virtual-unit width/height pair that (a) renders at exactly 65% of the real
 * device width OR 70% of the real device height, whichever is smaller (same
 * "contain fit" logic getUiScale() itself already uses for the whole scene),
 * and (b) always preserves SOCIAL_AGENDA_PANEL_ASPECT_RATIO exactly.
 */
/**
 * Bumped 0.44/0.48 -> 0.54/0.60 per real-device feedback that the first
 * mobile pass shrank this panel too far. Same contain-fit computation below,
 * untouched - only these two source fractions changed. (History: originally
 * 0.65/0.7, then 0.44/0.48 per "~65-70% of current size" feedback which
 * proved too aggressive once actually seen on a phone.)
 */
const AGENDA_MOBILE_WIDTH_FRACTION = 0.54
const AGENDA_MOBILE_MAX_HEIGHT_FRACTION = 0.6

function getMobileAgendaPanelSize(): { width: number; height: number } {
    const canvasInfo = UiCanvasInformation.getOrNull(engine.RootEntity)
    const scale = getUiScale()
    if (!canvasInfo || scale <= 0) {
        // No live canvas data yet - fall back to the fixed COMPACT size rather than 0/NaN.
        return { width: AGENDA_PANEL_WIDTH_COMPACT, height: AGENDA_PANEL_HEIGHT_COMPACT }
    }
    const widthDrivenWidth = (canvasInfo.width * AGENDA_MOBILE_WIDTH_FRACTION) / scale
    const widthDrivenHeight = widthDrivenWidth / SOCIAL_AGENDA_PANEL_ASPECT_RATIO
    const heightDrivenHeight = (canvasInfo.height * AGENDA_MOBILE_MAX_HEIGHT_FRACTION) / scale
    const heightDrivenWidth = heightDrivenHeight * SOCIAL_AGENDA_PANEL_ASPECT_RATIO
    // Contain-fit: whichever candidate is smaller respects BOTH the width and max-height limits at once, with zero deformation either way.
    return widthDrivenHeight <= heightDrivenHeight
        ? { width: widthDrivenWidth, height: widthDrivenHeight }
        : { width: heightDrivenWidth, height: heightDrivenHeight }
}

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

/**
 * Mobile-only (isMobile() real device, NOT the `compactUi` tier - a small
 * desktop preview window must keep the exact COMPACT sizes above) row
 * typography, ~12% larger than COMPACT per explicit "~10-15%" legibility
 * feedback: 17*1.12=19.04 (rounded 19), 14*1.12=15.68 (rounded 16),
 * 13*1.12=14.56 (rounded 15). Only used inside the row map below - the count
 * line/header/pagination footer are untouched.
 */
const AGENDA_NAME_FONT_SIZE_MOBILE = 19
const AGENDA_SECONDARY_FONT_SIZE_MOBILE = 16
const AGENDA_TERTIARY_FONT_SIZE_MOBILE = 15

/**
 * Mobile-only, higher-contrast row color overrides - per explicit real-device
 * legibility feedback. These are NEW, separate constants, never a change to
 * AGENDA_PINK/AGENDA_TEAL/CREAM_PANEL_TEXT_MUTED themselves (all three are
 * used throughout this file well beyond Social Agenda's rows, e.g. avatar
 * borders, dividers, WAITING/RESULT copy, the HUD counter) - desktop keeps
 * exactly those original colors, unchanged, "estética pastel" intact. Name
 * color is untouched on both platforms: AGENDA_BADGE_BACKGROUND (0.95, 0.2,
 * 0.5) is already the dark, saturated magenta this task asks for.
 * - Affinity: darker/more saturated pink than the pale AGENDA_PINK (1, 0.75, 0.9).
 * - Shared answers/rounds: darker mauve than CREAM_PANEL_TEXT_MUTED (0.45, 0.32, 0.4).
 * - Friendship tier: a stronger, more saturated blue than the pale AGENDA_TEAL (0.4, 0.75, 1).
 */
const AGENDA_MOBILE_AFFINITY_COLOR = Color4.create(0.85, 0.22, 0.48, 1)
const AGENDA_MOBILE_MUTED_COLOR = Color4.create(0.32, 0.18, 0.26, 1)
const AGENDA_MOBILE_TIER_COLOR = Color4.create(0.1, 0.5, 0.9, 1)

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

/** Strong magenta fallback fill (same AGENDA_BADGE_BACKGROUND used for the "YOU" badge elsewhere) for the profile-picture fallback silhouette, now that the row sits on light cream instead of a dark panel - the cream-colored silhouette shapes need a saturated, contrasting circle behind them, not a light one. */
const AGENDA_AVATAR_FALLBACK_BACKGROUND = AGENDA_BADGE_BACKGROUND

/**
 * A soft pastel-pink rule between consecutive connections - not a real
 * per-side border (uiTransform's borderWidth/borderColor apply to all four
 * sides at once in this SDK, with no per-side control - same limitation
 * already documented for leaderboardUi.tsx's subtab underline), so this is a
 * separate 1px-tall rectangle instead. Re-based on AGENDA_PINK now that the
 * row sits on cream paper instead of a dark panel - the old low-alpha cream
 * value (barely visible against near-black) would have all but disappeared
 * against the new light background, so the divider needed a genuinely
 * different color, not just a copy-pasted alpha tweak. Skipped after the LAST
 * row on a page (see SocialAgenda) so it never sits as a stray line directly
 * above the pagination footer.
 */
const AGENDA_ROW_DIVIDER_COLOR = Color4.create(AGENDA_PINK.r, AGENDA_PINK.g, AGENDA_PINK.b, 0.4)

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
const AGENDA_ROWS_PER_PAGE = 4
/**
 * Reduced row count for DESKTOP ONLY (never real mobile, which always stays
 * at AGENDA_ROWS_PER_PAGE=4) - used when EITHER isDesktopNarrow (uiScale too
 * low for this specific panel) OR hasAgendaBanner (the REVEAL banner is
 * eating real height) is true - see SocialAgenda's own doc comment for both
 * conditions. Normal desktop with no banner keeps 4, unchanged.
 */
const AGENDA_ROWS_PER_PAGE_DESKTOP_NARROW = 3
/**
 * Agenda-SPECIFIC desktop-narrow scale threshold - deliberately NOT
 * WIDE_MIN_SCALE (0.65). Real-device measurement (via the temp diagnostic
 * label) at window sizes where rows visibly overlapped: uiScale = 0.728
 * (1398x826) and, still overlapping even at 4 rows, uiScale = 0.829
 * (1592x954) - both comfortably ABOVE the old width/height-derived
 * breakpoints (1248/702) and above the first 0.80 threshold, so those
 * checks reported `narrow: false` at sizes that were already broken. 0.65
 * (and later 0.80) were simply too low FOR THIS PANEL specifically (a
 * fixed 760x842 image that never shrinks itself between WIDE/COMPACT,
 * unlike most other panels in this file - see AGENDA_PANEL_WIDTH_COMPACT's
 * own doc comment). 0.86 sits just above the measured 0.829 breaking
 * point, with a small safety margin. This constant is scoped to
 * SocialAgenda alone - WIDE_MIN_SCALE itself, and every other component
 * that reads it, are completely untouched.
 */
const AGENDA_DESKTOP_NARROW_SCALE_THRESHOLD = 0.86

// Desktop-narrow only: minimum gap the flexGrow spacer must reserve between
// the last connection row and the PREV/NEXT strip (it absorbs whatever
// leftover space exists, but a full page leaves little to absorb - this
// floor keeps the strip from ever crowding the last row), and the extra
// bottom margin that keeps the strip off the panel's own bottom edge.
const AGENDA_DESKTOP_NARROW_FOOTER_MIN_GAP = 16
const AGENDA_DESKTOP_NARROW_FOOTER_BOTTOM_MARGIN = 10

// Desktop-wide and mobile: top margin on the PREV/NEXT strip, bumped from the
// old flat 8 so there's always a small breathing gap above it, same as
// desktop-narrow already had via its own spacer. Desktop-narrow keeps its own
// top:8 (the flexGrow spacer above already does the real separation there).
const AGENDA_FOOTER_TOP_MARGIN = 18

/** Mobile-only RESULTS-title-to-cards gap - see its own use in RevealResults for why this needed to grow independently of GAMEPLAY_MOBILE_SCALE. Bumped again 18 -> 26 alongside the rest of the RESULT-on-mobile layout pass (see RESULTS_CARD_*_MOBILE's own doc comment) for a clearly visible gap now that the cards are also smaller. */
const RESULTS_TITLE_MARGIN_BOTTOM_MOBILE = 20

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
 * title (e.g. "An Exciting Possibility" - just the option text, no "A —"/"B —"
 * prefix, matching how ANSWERING already presents the same text unlabeled)
 * can wrap to 2 lines for longer question-bank options. Same root cause as
 * the earlier name-overlap bug: a
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
 * RESULT reskin - Social Quest family (cream/pink/teal/magenta) replacing the
 * old dark-violet/lavender look, which didn't match the palette used
 * everywhere else (HUD, Social Agenda, celebrations). A and B use IDENTICAL
 * styling - no green/red, no winner/loser treatment - "social discovery, not
 * competition" stays true after the reskin.
 *
 * "Mint cards" pass: the column fill is now a soft pastel mint, a light
 * blend of AGENDA_TEAL (Social Quest's existing teal accent) and AGENDA_CREAM
 * (the panel's own cream) rather than a new hue - deliberately NOT the same
 * as a semantic "correct answer" green, and both cards always use this exact
 * same fill regardless of counts/percentages. Text flipped from white (which
 * only worked against the old dark fill) to CREAM_PANEL_TEXT_MUTED, the same
 * "on-cream dark plum" text color already used elsewhere on light Social
 * Quest surfaces - titles use the stronger AGENDA_BADGE_BACKGROUND magenta
 * instead, for the PANEL CREAM -> MAGENTA TITLE -> MINT CARD -> DARK TEXT
 * hierarchy.
 */
const REVEAL_COLUMN_BACKGROUND = Color4.create(0.77, 0.87, 0.91, 1)
const REVEAL_COLUMN_BORDER_WIDTH = 1
/** Rounded a bit more than the old dark card's sharp-ish 10, to read as "cute" against the pastel fill - layout/size untouched, this only affects corner rounding. */
const REVEAL_COLUMN_BORDER_RADIUS = 16

/**
 * RESULT-on-mobile-only layout (isMobile() real device - never touches
 * ANSWERING, never touches desktop/`wide`/COMPACT-small-window sizing). Root
 * cause: GAMEPLAY_MOBILE_SCALE shrinks the OUTER gameplay panel container,
 * but every size below (title font, card width, title/stats/name-row
 * heights, padding, fonts) is a fixed pixel value from the COMPACT tier,
 * never itself scaled by that outer shrink - at the smaller mobile panel,
 * full-COMPACT-size cards AND the unconditional 32px "RESULTS" title ran too
 * wide/tall for the cream safe area and pushed past its edges/bottom. These
 * are a THIRD, independent tier (not a multiply-COMPACT factor) so each
 * value can be tuned on its own from real-device feedback.
 *
 * Second pass (more aggressive than the first, which was still overflowing)
 * fixed the overflow but overshot - too small. Third pass ("middle ground")
 * grew everything back but STILL read too small per real-device feedback.
 * Fourth pass pushes font sizes/row-heights/padding/width essentially back
 * to full COMPACT parity (the same numbers ANSWERING/RESULT already use on a
 * small desktop window) - the earlier passes were being too conservative on
 * a lever (per-card size/font) that was never the real overflow driver.
 * REVEAL_MAX_NAMES_MOBILE stays at 2 (unchanged, still the single biggest
 * height-saving lever) and RESULTS_TITLE_FONT_SIZE_MOBILE stays well under
 * the old unconditional 32 - between the two of those, the card content
 * below can afford to read at essentially COMPACT's own size without
 * reproducing the original overflow:
 *   title font 24 -> 26         width      185 -> 205   gap   11 -> 13
 *   padding     9 -> 11         title-area 32 -> 36      stats 16 -> 17
 *   name-row   18 -> 19         title font 14 -> 15 (= COMPACT)
 *   stats font 12 -> 13 (= COMPACT)   name font 13 -> 14 (= COMPACT)
 *   YOU badge font 8 -> 9 (= COMPACT)   +N MORE font 11 -> 12 (= COMPACT)
 * RESULTS_TITLE_MARGIN_BOTTOM_MOBILE left at 20 - already gave clear
 * separation from RESULTS per the last real-device check, no complaint
 * about it this round.
 */
const RESULTS_TITLE_FONT_SIZE_MOBILE = 26
const REVEAL_MAX_NAMES_MOBILE = 2
const RESULTS_CARD_WIDTH_MOBILE = 205
const RESULTS_CARD_GAP_MOBILE = 13
const RESULTS_CARD_PADDING_MOBILE = 11
const RESULTS_CARD_TITLE_AREA_HEIGHT_MOBILE = 36
const RESULTS_CARD_STATS_ROW_HEIGHT_MOBILE = 17
const RESULTS_CARD_NAME_ROW_HEIGHT_MOBILE = 19
const RESULTS_CARD_TITLE_FONT_SIZE_MOBILE = 15
const RESULTS_CARD_STATS_FONT_SIZE_MOBILE = 13
const RESULTS_CARD_NAME_FONT_SIZE_MOBILE = 14
const RESULTS_CARD_YOU_BADGE_FONT_SIZE_MOBILE = 9
const RESULTS_CARD_MORE_FONT_SIZE_MOBILE = 12

/**
 * Purely presentational truncation for a RESULT name row - never touches
 * entry.name (still resolved exactly as before by buildRevealData/
 * getDisplayName), only the final display string. Sized to leave room for
 * the "YOU" badge on the local player's own row.
 */
const RESULT_NAME_MAX_CHARS_WIDE = 20
const RESULT_NAME_MAX_CHARS_COMPACT = 14

function truncateResultName(name: string, wide: boolean): string {
    const maxChars = wide ? RESULT_NAME_MAX_CHARS_WIDE : RESULT_NAME_MAX_CHARS_COMPACT
    if (name.length <= maxChars) return name
    return `${name.slice(0, maxChars - 1)}…`
}

/**
 * Short entrance fade+pop for the RESULTS block - see
 * tickResultRevealPresentation's own doc comment for the edge-detect that
 * drives it. Width-only "pop" (not a true 2D scale): both ResultColumns have
 * an exact, already-known base width (320/220), but their HEIGHT is
 * content-driven (depends on how many names/rows are needed) - scaling an
 * unknown height would mean re-deriving RevealResults' own row-height math
 * here just for a barely-visible 8% pop, which isn't worth the fragility for
 * something this subtle. A width-only grow-in reads as a pop while staying
 * simple and exactly in sync with the real layout.
 */
const RESULT_REVEAL_POP_SECONDS = 0.18
const RESULT_REVEAL_POP_START_SCALE = 0.92

let resultRevealElapsedSeconds = 0
let wasShowingResultReveal = false

/**
 * Edge-detects the exact frame RESULT's reveal first becomes visible
 * (isRevealing flips to false with real reveal data) and starts a fresh
 * elapsed-time count from there - NOT a fingerprint of the reveal's content,
 * deliberately: RevealData is "live-recomputed every read... to absorb
 * late-arriving answers" (see its own doc comment), so a late answer
 * refreshing `reveal.entries` mid-RESULT must NOT restart the pop animation,
 * only the initial appearance should. Never touches roundManager.ts/
 * RESULT_SECONDS/REVEAL_TIMEOUT_SECONDS - reads roundManager.getSnapshot()
 * the same way uiMenu/JoinedGameplay already do, purely as this file's own
 * presentation-layer system (registered once from setupUi()).
 */
function tickResultRevealPresentation(dt: number): void {
    const { phase, isRevealing, reveal } = roundManager.getSnapshot()
    const showingReveal = phase === 'result' && !isRevealing && reveal !== null
    if (showingReveal && !wasShowingResultReveal) {
        resultRevealElapsedSeconds = 0
    } else if (showingReveal) {
        resultRevealElapsedSeconds += dt
    }
    wasShowingResultReveal = showingReveal
}

interface ResultRevealPresentation {
    opacity: number
    scale: number
}

function getResultRevealPresentation(): ResultRevealPresentation {
    const progress = Math.min(1, resultRevealElapsedSeconds / RESULT_REVEAL_POP_SECONDS)
    return { opacity: progress, scale: RESULT_REVEAL_POP_START_SCALE + (1 - RESULT_REVEAL_POP_START_SCALE) * progress }
}

/**
 * "Lobby" tier content sizing - JOIN, WAITING FOR ANOTHER PLAYER, PREPARING...,
 * and AFK messages (REMOVED/STILL THERE) all share this one family now
 * (see showingGameplayPanel in uiMenu), instead of JOIN/PREPARING/AFK
 * previously getting the much bigger gameplay-sized panel by accident.
 * JOIN keeps its own unrelated sizing note (see uiMenu) only for
 * showingJoinScreen's extra top margin, not for this width/height itself.
 */
const WAITING_PANEL_WIDTH = 480
const WAITING_PANEL_PADDING = 20
const WAITING_TITLE_FONT_SIZE = 24
const WAITING_TITLE_MARGIN_BOTTOM = 10
/**
 * Fixed content height for the whole lobby tier (JOIN/WAITING/PREPARING/AFK) -
 * NOT auto/content-driven, unlike before. Two reasons: (1) "JOIN y WAITING
 * deben sentirse parte del mismo sistema" - one shared height achieves that
 * directly; (2) an auto-height box containing a wrap-enabled Label ("Answer
 * the next question to stay in Social Quest.") doesn't reliably report its
 * real rendered height back to this SDK's flex layout (the same root cause
 * documented for the question-overlap and name-list bugs elsewhere in this
 * file) - the safe-area's own centering was computing against that
 * unreliable auto-height, which is why STILL THERE rendered too high. A
 * fixed height sidesteps the measurement entirely. Sized to comfortably fit
 * the tallest lobby case (JOIN NEXT ROUND's "N PLAYERS ACTIVE" line + the
 * 90px-tall button, ~137px) with a little room to spare - shorter content
 * (a single line, or WAITING's two short lines) just centers within the
 * extra space via the content panel's own justifyContent:'center' (lobby
 * only - gameplay keeps its existing top-down flow, untouched).
 */
const LOBBY_PANEL_HEIGHT = 145

/**
 * Social Quest decorative panel background - replaces BOTH the flat dark
 * `Color4.create(0.05, 0.05, 0.1, 0.85)` fill AND the separate graphic logo
 * that briefly replaced the yellow "SOCIAL QUEST" text (this new asset
 * already bakes that same logo art into its own top edge, so the standalone
 * logo render is fully removed here - never duplicated).
 *
 * Confirmed via the file's own raw PNG header (never assumed): 1536x1024, an
 * exact 1.5:1 aspect ratio, RGBA with alpha - WIDTH is always derived from
 * HEIGHT via SOCIAL_QUEST_PANEL_BACKGROUND_ASPECT_RATIO, never stretched.
 *
 * The art's own baked-in logo cluster occupies roughly its top third, with a
 * cream rounded-rectangle "safe zone" below it (~34%-93% of the height,
 * ~6%-93% of the width, confirmed by visually inspecting the asset) framed
 * by hearts/sparkles/speech-bubble decoration in the corners. Those
 * percentages are intrinsic to the artwork itself, not to whatever pixel
 * size it's rendered at - they stay exactly the same for both tiers below,
 * only the absolute pixel size (and therefore the absolute pixel size of the
 * cream zone) changes.
 *
 * Two size tiers, reduced from the previous single-size pass per explicit QA
 * feedback ("JOIN está usando un panel enorme para un solo botón"):
 * - "Lobby" (JOIN/WAITING/PREPARING/AFK messages) - 780x520 WIDE, 660x440
 *   COMPACT. Its own content (LOBBY_PANEL_HEIGHT=145 max) fits with huge
 *   room to spare inside either tier's cream zone.
 * - "Gameplay" (COUNTDOWN/ANSWERING/ANSWER LOCKED/REVEALING/RESULT) - 1200x800
 *   WIDE, 960x640 COMPACT, down from 1380x920 - "quiero ganar algo más de
 *   visión del mundo 3D". This shrinks the gameplay cream zone enough that
 *   RESULT's own absolute worst case (REVEAL_MAX_NAMES_WIDE names on both
 *   sides) now fits with only a few px to spare at WIDE - see the trimmed
 *   GAMEPLAY_PANEL_PADDING/ANSWERING_QUESTION_MARGIN_BOTTOM_WIDE/
 *   ANSWERING_QUESTION_AREA_HEIGHT_WIDE and RESULTS' own margin-bottom
 *   nearby, none of which touch ResultColumn itself.
 */
const SOCIAL_QUEST_PANEL_BACKGROUND_PATH = 'assets/images/social-quest-panel-background.png'
const SOCIAL_QUEST_PANEL_BACKGROUND_ASPECT_RATIO = 1536 / 1024
const SOCIAL_QUEST_PANEL_BACKGROUND_SAFE_AREA_TOP_PERCENT = '34%'
const SOCIAL_QUEST_PANEL_BACKGROUND_SAFE_AREA_HEIGHT_PERCENT = '59%'
const SOCIAL_QUEST_PANEL_BACKGROUND_GAMEPLAY_HEIGHT_WIDE = 800
const SOCIAL_QUEST_PANEL_BACKGROUND_GAMEPLAY_HEIGHT_COMPACT = 640
const SOCIAL_QUEST_PANEL_BACKGROUND_LOBBY_HEIGHT_WIDE = 520
const SOCIAL_QUEST_PANEL_BACKGROUND_LOBBY_HEIGHT_COMPACT = 440

/**
 * `showingGameplayPanel` - true ONLY for COUNTDOWN/ANSWERING/ANSWER LOCKED/REVEALING/RESULT
 * (see this constant block's own doc comment); false (the "lobby" tier) for JOIN/WAITING/
 * PREPARING/AFK messages. `isRealMobileDevice` (bare isMobile(), NOT `compact` - see
 * GAMEPLAY_MOBILE_SCALE's own doc comment) additionally shrinks the COMPACT-tier height by
 * GAMEPLAY_MOBILE_SCALE on a real phone only - width is re-derived from that same shrunk
 * height via SOCIAL_QUEST_PANEL_BACKGROUND_ASPECT_RATIO, so the aspect ratio is never at risk.
 */
function getSocialQuestPanelBackgroundSize(showingGameplayPanel: boolean, compact: boolean, isRealMobileDevice: boolean): { width: number; height: number } {
    const baseHeight = showingGameplayPanel
        ? compact
            ? SOCIAL_QUEST_PANEL_BACKGROUND_GAMEPLAY_HEIGHT_COMPACT
            : SOCIAL_QUEST_PANEL_BACKGROUND_GAMEPLAY_HEIGHT_WIDE
        : compact
          ? SOCIAL_QUEST_PANEL_BACKGROUND_LOBBY_HEIGHT_COMPACT
          : SOCIAL_QUEST_PANEL_BACKGROUND_LOBBY_HEIGHT_WIDE
    const height = isRealMobileDevice ? baseHeight * GAMEPLAY_MOBILE_SCALE : baseHeight
    return { width: height * SOCIAL_QUEST_PANEL_BACKGROUND_ASPECT_RATIO, height }
}

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
 * uiMenu's showingGameplayPanel gate) - same width/padding/position/title on
 * every platform and across all three phases, with a FIXED height (not
 * auto) so the panel never resizes across that phase transition: ANSWER
 * LOCKED's shorter content just leaves blank space at the bottom instead of
 * shrinking the panel, and RESULT's cards have guaranteed room without ever
 * having driven the panel's size themselves. The height only tiers by
 * `compact` (isMobile() || !wide), same signal as everywhere else in this
 * file.
 *
 * HEIGHT_WIDE/COMPACT (540/430 -> 470/375) and PADDING (36 -> 24) both
 * trimmed to fit inside the smaller "gameplay" panel-background cream zone
 * introduced for that asset ("quiero ganar algo más de visión del mundo 3D"
 * - see SOCIAL_QUEST_PANEL_BACKGROUND_*'s own doc comment): the panel's own
 * declared height always renders in full regardless of which phase is
 * showing (that's the whole point of a fixed, non-auto height), so it has to
 * fit inside the new, smaller cream zone on its own - not just whatever
 * content happens to be visible. At WIDE, this new height - together with
 * the trimmed GAMEPLAY_PANEL_PADDING, ANSWERING_QUESTION_MARGIN_BOTTOM_WIDE,
 * ANSWERING_QUESTION_AREA_HEIGHT_WIDE, and RESULTS' own margin-bottom - is
 * what makes RESULT's absolute worst case (REVEAL_MAX_NAMES_WIDE names on
 * both sides) fit again, calculated to leave only a couple of px of real
 * margin (a genuine trade-off of the smaller panel, not pixel-perfect -
 * recommend a live check of that specific 5-vs-5 case). COMPACT keeps
 * comfortable slack. None of ResultColumn's own sizing was touched.
 */
const GAMEPLAY_PANEL_WIDTH = 760
const GAMEPLAY_PANEL_PADDING = 24
const GAMEPLAY_PANEL_HEIGHT_WIDE = 470
const GAMEPLAY_PANEL_HEIGHT_COMPACT = 375

/**
 * ANSWERING's own content sizing tiers by `compact` (isMobile() || !wide),
 * the same wide/compact-tier pattern RevealResults already uses for RESULT,
 * its already-proven-on-real-mobile reference. The outer panel itself is the
 * shared GAMEPLAY_PANEL_* shell above, not sized here.
 */
const ANSWERING_QUESTION_FONT_SIZE_WIDE = 32
const ANSWERING_QUESTION_FONT_SIZE_COMPACT = 24
/** WIDE trimmed 28 -> 14 to help RESULT's worst case fit the smaller gameplay panel (see GAMEPLAY_PANEL_HEIGHT_WIDE's own doc comment) - still a real, deliberate gap, just tighter than before. COMPACT untouched (already had comfortable slack). */
const ANSWERING_QUESTION_MARGIN_BOTTOM_WIDE = 14
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
 *
 * WIDE trimmed slightly (88 -> 84) to help fit the smaller gameplay panel -
 * still comfortably above the 2-line minimum (2 * 32px font * ~1.3 line-
 * height ratio = 83.2px), so the "always fits 2 lines" guarantee this exists
 * for is preserved, just with less spare cushion than before.
 */
const ANSWERING_QUESTION_AREA_HEIGHT_WIDE = 84
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
 * into this SDK's flex layout.
 *
 * Code-only visual test (no new PNGs): rounded cream/pink "cute" cards
 * replacing the default red Button rectangles. COMPACT height in particular
 * dropped a lot (120 -> 82) since the pill-shaped card needs less vertical
 * room than the old rectangle to feel proportionate - freeing vertical
 * budget rather than spending more of it, so this stays within the already
 * tight GAMEPLAY_PANEL_HEIGHT_* fit documented above.
 */
const ANSWER_BUTTON_WIDTH_WIDE = 285
const ANSWER_BUTTON_HEIGHT_WIDE = 92
const ANSWER_BUTTON_GAP_WIDE = 16
const ANSWER_BUTTON_WIDTH_COMPACT = 225
const ANSWER_BUTTON_HEIGHT_COMPACT = 82
const ANSWER_BUTTON_GAP_COMPACT = 10
const ANSWER_BUTTON_BORDER_RADIUS_WIDE = 28
const ANSWER_BUTTON_BORDER_RADIUS_COMPACT = 24
const ANSWER_BUTTON_BORDER_WIDTH = 2
const ANSWER_BUTTON_BORDER_WIDTH_HOVER = 3
const ANSWER_BUTTON_PADDING_HORIZONTAL = 12
/** Multiplies the cream/pink/magenta channels of the non-chosen button once locked - de-emphasis via opacity/desaturation only, deliberately never a color swap (no green/red - there is no correct answer in Social Quest). */
const ANSWER_BUTTON_UNSELECTED_DIM_FACTOR = 0.45

/**
 * Dynamic font-size steps by option text length, retuned smaller for the new
 * card shape's tighter COMPACT height. SHORT/MEDIUM bumped +1px per visual
 * QA feedback (legibility) - LONG deliberately left untouched, since it's
 * the tier that has to stay safely within the 2-line wrap budget.
 */
const ANSWER_FONT_SIZE_SHORT_WIDE = 20
const ANSWER_FONT_SIZE_MEDIUM_WIDE = 19
const ANSWER_FONT_SIZE_LONG_WIDE = 17
const ANSWER_FONT_SIZE_SHORT_COMPACT = 17
const ANSWER_FONT_SIZE_MEDIUM_COMPACT = 16
const ANSWER_FONT_SIZE_LONG_COMPACT = 14
const ANSWER_SHORT_MAX_CHARS = 16
const ANSWER_MEDIUM_MAX_CHARS = 28

function answerFontSize(text: string, compact: boolean): number {
    if (text.length <= ANSWER_SHORT_MAX_CHARS) return compact ? ANSWER_FONT_SIZE_SHORT_COMPACT : ANSWER_FONT_SIZE_SHORT_WIDE
    if (text.length <= ANSWER_MEDIUM_MAX_CHARS) return compact ? ANSWER_FONT_SIZE_MEDIUM_COMPACT : ANSWER_FONT_SIZE_MEDIUM_WIDE
    return compact ? ANSWER_FONT_SIZE_LONG_COMPACT : ANSWER_FONT_SIZE_LONG_WIDE
}

/**
 * One ANSWERING option button - rounded cream card, no A/B markers or icons,
 * equal visual weight on both sides. `state` drives the palette:
 *   - 'interactive': pre-lock, cream/pink/magenta by default, pink border
 *     turns teal (and slightly thicker) on hover.
 *   - 'selected': the option the player locked in - solid pink fill, cream
 *     text, no hover reaction (nothing left to interact with).
 *   - 'unselected': the other option once locked - same interactive look,
 *     just dimmed via ANSWER_BUTTON_UNSELECTED_DIM_FACTOR (opacity only,
 *     never a color swap - no green/red, there is no correct answer here).
 * `hovered` is read-only here; the caller owns and resets the flag (see
 * answerOptionAHovered/answerOptionBHovered's own doc comment).
 */
const AnswerOptionButton = ({
    text,
    fontSize,
    compact,
    state,
    hovered,
    margin,
    onMouseDown,
    onMouseEnter,
    onMouseLeave
}: {
    text: string
    fontSize: number
    compact: boolean
    state: 'interactive' | 'selected' | 'unselected'
    hovered: boolean
    margin: { left?: number; right?: number }
    onMouseDown?: () => void
    onMouseEnter?: () => void
    onMouseLeave?: () => void
}) => {
    const dim = state === 'unselected' ? ANSWER_BUTTON_UNSELECTED_DIM_FACTOR : 1
    const showHover = hovered && state === 'interactive'
    const background =
        state === 'selected'
            ? AGENDA_BADGE_BACKGROUND
            : Color4.create(AGENDA_CREAM.r, AGENDA_CREAM.g, AGENDA_CREAM.b, AGENDA_CREAM.a * dim)
    const borderColor =
        state === 'selected'
            ? AGENDA_BADGE_BACKGROUND
            : showHover
              ? Color4.create(AGENDA_TEAL.r, AGENDA_TEAL.g, AGENDA_TEAL.b, AGENDA_TEAL.a * dim)
              : Color4.create(AGENDA_PINK.r, AGENDA_PINK.g, AGENDA_PINK.b, AGENDA_PINK.a * dim)
    const textColor =
        state === 'selected'
            ? AGENDA_CREAM
            : Color4.create(
                  AGENDA_BADGE_BACKGROUND.r,
                  AGENDA_BADGE_BACKGROUND.g,
                  AGENDA_BADGE_BACKGROUND.b,
                  AGENDA_BADGE_BACKGROUND.a * dim
              )

    return (
        <UiEntity
            uiTransform={{
                width: compact ? ANSWER_BUTTON_WIDTH_COMPACT : ANSWER_BUTTON_WIDTH_WIDE,
                height: compact ? ANSWER_BUTTON_HEIGHT_COMPACT : ANSWER_BUTTON_HEIGHT_WIDE,
                margin,
                padding: { left: ANSWER_BUTTON_PADDING_HORIZONTAL, right: ANSWER_BUTTON_PADDING_HORIZONTAL },
                borderRadius: compact ? ANSWER_BUTTON_BORDER_RADIUS_COMPACT : ANSWER_BUTTON_BORDER_RADIUS_WIDE,
                borderWidth: showHover ? ANSWER_BUTTON_BORDER_WIDTH_HOVER : ANSWER_BUTTON_BORDER_WIDTH,
                borderColor,
                justifyContent: 'center',
                alignItems: 'center'
            }}
            uiBackground={{ color: background }}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            onMouseDown={onMouseDown}
        >
            {/* height:'100%' (not left auto) is deliberate - same fix as the reserved-zone
                pattern used throughout this file (see ANSWER_BUTTON_PADDING_HORIZONTAL's
                sibling constants' area / REVEAL_TITLE_AREA_HEIGHT_*'s doc comment): a
                wrap-enabled Label's own measured height isn't reliably fed back into this
                SDK's flex layout, so textAlign="middle-center" was centering within an
                unreliable auto box and the text visually sat low. Giving it the button's
                own exact, known height makes the centering deterministic. */}
            <Label
                value={text}
                fontSize={fontSize}
                textAlign="middle-center"
                textWrap="wrap"
                color={textColor}
                uiTransform={{ width: '100%', height: '100%' }}
            />
        </UiEntity>
    )
}

const JOIN_BUTTON_WIDTH_WIDE = 265
const JOIN_BUTTON_HEIGHT_WIDE = 76
const JOIN_BUTTON_WIDTH_COMPACT = 225
const JOIN_BUTTON_HEIGHT_COMPACT = 70
const JOIN_BUTTON_BORDER_RADIUS_WIDE = 30
const JOIN_BUTTON_BORDER_RADIUS_COMPACT = 26
const JOIN_BUTTON_BORDER_WIDTH = 3
const JOIN_BUTTON_BORDER_WIDTH_HOVER = 4
const JOIN_BUTTON_FONT_SIZE_WIDE = 19
const JOIN_BUTTON_FONT_SIZE_COMPACT = 16

/**
 * JOIN button - same cream/pink/magenta card language as the answer buttons,
 * but with a more marked border (JOIN_BUTTON_BORDER_WIDTH > ANSWER_BUTTON_
 * BORDER_WIDTH) since it's the lobby's single call-to-action rather than one
 * of two equal options. No new PNG - code-only, per the visual test scope.
 */
const JoinButton = ({
    label,
    fontSize,
    width,
    height,
    borderRadius
}: {
    label: string
    fontSize: number
    width: number
    height: number
    borderRadius: number
}) => {
    const borderColor = joinButtonHovered ? AGENDA_TEAL : AGENDA_PINK
    const borderWidth = joinButtonHovered ? JOIN_BUTTON_BORDER_WIDTH_HOVER : JOIN_BUTTON_BORDER_WIDTH

    return (
        <UiEntity
            uiTransform={{
                width,
                height,
                borderRadius,
                borderWidth,
                borderColor,
                justifyContent: 'center',
                alignItems: 'center',
                padding: { left: 16, right: 16 }
            }}
            uiBackground={{ color: AGENDA_CREAM }}
            onMouseEnter={() => (joinButtonHovered = true)}
            onMouseLeave={() => (joinButtonHovered = false)}
            onMouseDown={() => playerSessionManager.joinSocialQuest()}
        >
            {/* height:'100%' for the same reason as AnswerOptionButton's own Label - see its comment. */}
            <Label
                value={label}
                fontSize={fontSize}
                textAlign="middle-center"
                textWrap="wrap"
                color={AGENDA_BADGE_BACKGROUND}
                uiTransform={{ width: '100%', height: '100%' }}
            />
        </UiEntity>
    )
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
    /**
     * Bare isMobile() (real device only, never a narrow desktop preview window)
     * - reused below for (a) the top-right HUD relocation and (b) the questions
     * panel's mobile shrink. Deliberately a different signal from `compact`
     * (which is also true for a small desktop window): both this task's HUD
     * repositioning and panel shrinking are explicitly real-phone-only, with
     * desktop required to stay pixel-identical to today - same reasoning as
     * SocialAgenda's own isRealMobileDevice.
     */
    const isRealMobileDevice = isMobile()
    /**
     * COUNTDOWN/ANSWERING/ANSWER LOCKED/REVEALING/RESULT - the phases that
     * share the fixed GAMEPLAY_PANEL_HEIGHT_* shell AND the bigger
     * "gameplay" panel-background tier (see its own doc comment). COUNTDOWN
     * included so the panel doesn't resize/flicker right before the question
     * it leads straight into. Requires session.joined (a round already in
     * progress while this player hasn't joined yet renders JoinScreen, not
     * JoinedGameplay) AND no active AFK message (REMOVED/STILL THERE take
     * over the screen regardless of round.phase, and belong with the
     * "lobby" tier instead, alongside JOIN/WAITING/PREPARING). Everything
     * else in this file that used to branch on the old `isWaitingPhase` now
     * branches on `!showingGameplayPanel` instead - a single "lobby vs
     * gameplay" split replacing the previous phase-based one.
     */
    const showingGameplayPanel =
        session.joined && round.afkMessage === null && (round.phase === 'countdown' || round.phase === 'answering' || round.phase === 'result')
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
    const socialQuestPanelBackgroundSize = getSocialQuestPanelBackgroundSize(showingGameplayPanel, compact, isRealMobileDevice)

    return (
        // Keeps the panel clear of the device notch, status bar and rounded corners on mobile
        <ScreenInsetArea>
            {/* DESKTOP ONLY (isRealMobileDevice false) - byte-identical to the pre-existing
                layout, per explicit "desktop queda exactamente como está" instruction. See
                the mobile branch just below for the top-right relocation on a real phone.

                Persistent Social HUD + temporary celebrations, upper-center: real Explorer
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
            {!isRealMobileDevice && (
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
                            // pointerFilter:'none' - purely informational, must never intercept clicks meant for the HUD buttons beneath/around it (same principle already proven on SocialPointsValidRoundToast).
                            <UiEntity uiTransform={{ margin: { left: wide ? WIDE_ROW_GAP : COMPACT_ROW_GAP }, pointerFilter: 'none' }}>
                                <NewConnectionToast
                                    data={presentedNewConnection}
                                    presentation={getActiveCelebrationPresentation(presentedNewConnection)}
                                    wide={wide}
                                />
                            </UiEntity>
                        )}
                        {presentedFriendship && (
                            // pointerFilter:'none' - same reasoning as the NewConnectionToast wrapper above.
                            <UiEntity uiTransform={{ margin: { left: wide ? WIDE_ROW_GAP : COMPACT_ROW_GAP }, pointerFilter: 'none' }}>
                                <FriendshipToast
                                    data={presentedFriendship}
                                    presentation={getActiveCelebrationPresentation(presentedFriendship)}
                                    wide={wide}
                                />
                            </UiEntity>
                        )}
                    </UiEntity>
                </UiEntity>
            )}
            {/* MOBILE ONLY (isRealMobileDevice) - same three elements (Agenda/Leaderboard/SP
                Counter) and the same SocialPointsValidRoundToast/celebration toasts as the
                desktop row above, relocated to the top-right corner per explicit instruction:
                on a real phone, top-left is avatar/chat/compass and bottom-right is the native
                E/F/jump/hand controls, leaving top-right free. Stacked in a column (button row,
                then any active celebration toast below it, right-aligned) rather than the
                desktop's two-slot row - a horizontal right-slot toast would run back into the
                relocated buttons instead of away from them the way it does on desktop. Nothing
                is hidden here - every element desktop shows is still shown, just repositioned. */}
            {isRealMobileDevice && (
                <UiEntity
                    uiTransform={{
                        positionType: 'absolute',
                        position: { top: HUD_TOP_MARGIN, right: HUD_MOBILE_RIGHT_MARGIN },
                        flexDirection: 'column',
                        alignItems: 'flex-end'
                    }}
                >
                    <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center' }}>
                        <SocialAgendaButton wide={wide} />
                        <UiEntity uiTransform={{ width: SOCIAL_HUD_GROUP_GAP }} />
                        <LeaderboardButton wide={wide} onOpen={() => { socialAgendaOpen = false }} />
                        <UiEntity uiTransform={{ width: SOCIAL_HUD_GROUP_GAP }} />
                        <SocialPointsCounter wide={wide} />
                        {activeSocialPointsReward && <SocialPointsValidRoundToast data={activeSocialPointsReward} wide={wide} />}
                    </UiEntity>
                    {(presentedNewConnection || presentedFriendship) && (
                        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'flex-end', margin: { top: COMPACT_ROW_GAP } }}>
                            {presentedNewConnection && (
                                <UiEntity uiTransform={{ pointerFilter: 'none' }}>
                                    <NewConnectionToast
                                        data={presentedNewConnection}
                                        presentation={getActiveCelebrationPresentation(presentedNewConnection)}
                                        wide={wide}
                                    />
                                </UiEntity>
                            )}
                            {presentedFriendship && (
                                <UiEntity uiTransform={{ pointerFilter: 'none', margin: { top: presentedNewConnection ? COMPACT_ROW_GAP : 0 } }}>
                                    <FriendshipToast
                                        data={presentedFriendship}
                                        presentation={getActiveCelebrationPresentation(presentedFriendship)}
                                        wide={wide}
                                    />
                                </UiEntity>
                            )}
                        </UiEntity>
                    )}
                </UiEntity>
            )}

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
                            width: socialQuestPanelBackgroundSize.width,
                            height: socialQuestPanelBackgroundSize.height,
                            margin: { top: showingJoinScreen ? JOIN_EXTRA_TOP_MARGIN : 0 },
                            justifyContent: 'center',
                            alignItems: 'center'
                        }}
                        uiBackground={{ texture: { src: SOCIAL_QUEST_PANEL_BACKGROUND_PATH }, textureMode: 'stretch' }}
                    >
                        {/* Safe area: a horizontal band inside the background's own cream zone (see
                            SOCIAL_QUEST_PANEL_BACKGROUND_*'s own doc comment for the exact
                            percentages) - spans the FULL outer width so the unchanged, narrower
                            content panel below just centers itself well inside the cream zone's own
                            (much wider) horizontal room, with no need for a separate left/width
                            percentage - the background's own size was already chosen specifically so
                            this fits. */}
                        <UiEntity
                            uiTransform={{
                                positionType: 'absolute',
                                position: { top: SOCIAL_QUEST_PANEL_BACKGROUND_SAFE_AREA_TOP_PERCENT },
                                width: '100%',
                                height: SOCIAL_QUEST_PANEL_BACKGROUND_SAFE_AREA_HEIGHT_PERCENT,
                                justifyContent: 'center',
                                alignItems: 'center'
                            }}
                        >
                            {/* The actual content panel - width/height/padding UNCHANGED from
                                before (still GAMEPLAY_PANEL_* / WAITING_PANEL_*), no uiBackground of
                                its own anymore (the new asset behind it already provides the visual) -
                                every child inside (AFK messages, JoinScreen, JoinedGameplay - question
                                layout, answer buttons, RESULT columns/badges/animation) is completely
                                untouched. */}
                            <UiEntity
                                uiTransform={{
                                    width:
                                        (showingGameplayPanel ? GAMEPLAY_PANEL_WIDTH : WAITING_PANEL_WIDTH) *
                                        (isRealMobileDevice ? GAMEPLAY_MOBILE_SCALE : 1),
                                    height:
                                        (showingGameplayPanel ? (compact ? GAMEPLAY_PANEL_HEIGHT_COMPACT : GAMEPLAY_PANEL_HEIGHT_WIDE) : LOBBY_PANEL_HEIGHT) *
                                        (isRealMobileDevice ? GAMEPLAY_MOBILE_SCALE : 1),
                                    padding: showingGameplayPanel ? GAMEPLAY_PANEL_PADDING : WAITING_PANEL_PADDING,
                                    flexDirection: 'column',
                                    // Lobby only: centers JOIN/WAITING/PREPARING/AFK content vertically
                                    // within the now-fixed LOBBY_PANEL_HEIGHT (see its own doc comment
                                    // for why fixed, not auto). Gameplay keeps its existing top-down flow
                                    // (title -> question -> timer/buttons or RESULT), untouched.
                                    justifyContent: showingGameplayPanel ? 'flex-start' : 'center',
                                    alignItems: 'center'
                                }}
                            >
                                {round.afkMessage === 'removed' ? (
                                    <UiEntity uiTransform={COLUMN_CENTERED}>
                                        <Label
                                            value="REMOVED FOR INACTIVITY"
                                            fontSize={30}
                                            color={Color4.create(1, 0.5, 0.4, 1)}
                                            uiTransform={{ margin: { bottom: 12 } }}
                                        />
                                        <Label value="You missed 2 questions." fontSize={22} color={CREAM_PANEL_TEXT_MUTED} />
                                    </UiEntity>
                                ) : round.afkMessage === 'warning' ? (
                                    <UiEntity uiTransform={COLUMN_CENTERED}>
                                        <Label
                                            value="STILL THERE?"
                                            fontSize={30}
                                            color={AGENDA_BADGE_BACKGROUND}
                                            uiTransform={{ margin: { bottom: 12 } }}
                                        />
                                        <Label
                                            value="Answer the next question to stay in Social Quest."
                                            fontSize={20}
                                            textAlign="middle-center"
                                            textWrap="wrap"
                                            color={CREAM_PANEL_TEXT_MUTED}
                                        />
                                    </UiEntity>
                                ) : !session.isSafeToJoin ? (
                                    <Label value="PREPARING SOCIAL QUEST..." fontSize={32} color={AGENDA_BADGE_BACKGROUND} />
                                ) : !session.joined ? (
                                    <JoinScreen />
                                ) : (
                                    <JoinedGameplay />
                                )}
                            </UiEntity>
                        </UiEntity>
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
    const wide = getUiScale() >= WIDE_MIN_SCALE
    // Same isMobile()-OR'd signal as uiMenu's own `compact` - see its doc comment.
    const compact = isMobile() || !wide

    return (
        <UiEntity uiTransform={COLUMN_CENTERED}>
            {roundAlreadyActive && (
                <Label
                    value={`${round.activeParticipantCount} PLAYERS ACTIVE`}
                    fontSize={24}
                    color={CREAM_PANEL_TEXT_MUTED}
                    uiTransform={{ margin: { bottom: 16 } }}
                />
            )}
            <JoinButton
                label={roundAlreadyActive ? 'JOIN NEXT ROUND' : 'JOIN SOCIAL QUEST'}
                fontSize={compact ? JOIN_BUTTON_FONT_SIZE_COMPACT : JOIN_BUTTON_FONT_SIZE_WIDE}
                width={compact ? JOIN_BUTTON_WIDTH_COMPACT : JOIN_BUTTON_WIDTH_WIDE}
                height={compact ? JOIN_BUTTON_HEIGHT_COMPACT : JOIN_BUTTON_HEIGHT_WIDE}
                borderRadius={compact ? JOIN_BUTTON_BORDER_RADIUS_COMPACT : JOIN_BUTTON_BORDER_RADIUS_WIDE}
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

    // Reset button-hover flags whenever their owning buttons aren't the ones currently
    // on screen - see answerOptionAHovered/joinButtonHovered's own doc comment for why
    // this can't rely on onMouseLeave alone (mount/unmount across phases/rounds).
    joinButtonHovered = false
    if (phase !== 'answering' || selectedOption !== null) {
        answerOptionAHovered = false
        answerOptionBHovered = false
    }

    if (isPending) {
        return (
            <UiEntity uiTransform={COLUMN_CENTERED}>
                <Label
                    value="JOINING NEXT ROUND..."
                    fontSize={32}
                    textAlign="middle-center"
                    textWrap="wrap"
                    color={AGENDA_BADGE_BACKGROUND}
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
                    color={AGENDA_BADGE_BACKGROUND}
                    uiTransform={{ width: '100%', margin: { bottom: WAITING_TEXT_MARGIN_BOTTOM } }}
                />
                <Label
                    value={`${activeParticipantCount} / ${MIN_PLAYERS_REQUIRED}`}
                    fontSize={WAITING_COUNT_FONT_SIZE}
                    color={CREAM_PANEL_TEXT_MUTED}
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
                    color={CREAM_PANEL_TEXT_MUTED}
                    uiTransform={{ width: '100%', margin: { bottom: COUNTDOWN_TITLE_MARGIN_BOTTOM } }}
                />
                <Label value={`${secondsLeft}`} fontSize={COUNTDOWN_NUMBER_FONT_SIZE} color={Color4.create(1, 0.85, 0.2, 1)} />
            </UiEntity>
        )
    }

    // Guaranteed non-null by RoundManager whenever phase is 'answering' or 'result'
    const activeQuestion = question as NonNullable<typeof question>

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
                    color={AGENDA_BADGE_BACKGROUND}
                    uiTransform={{ width: '100%' }}
                />
            </UiEntity>

            {phase === 'answering' ? (
                <UiEntity uiTransform={COLUMN_CENTERED}>
                    {/* Countdown: visible but kept small so it stays secondary to the question/buttons */}
                    <Label
                        value={`${secondsLeft}s`}
                        fontSize={compact ? ANSWERING_TIMER_FONT_SIZE_COMPACT : ANSWERING_TIMER_FONT_SIZE_WIDE}
                        color={AGENDA_TEAL}
                        uiTransform={{ margin: { bottom: compact ? ANSWERING_TIMER_MARGIN_BOTTOM_COMPACT : ANSWERING_TIMER_MARGIN_BOTTOM_WIDE } }}
                    />

                    {selectedOption === null ? (
                        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                            <AnswerOptionButton
                                text={activeQuestion.optionA}
                                fontSize={answerFontSize(activeQuestion.optionA, compact)}
                                compact={compact}
                                state="interactive"
                                hovered={answerOptionAHovered}
                                margin={compact ? { right: ANSWER_BUTTON_GAP_COMPACT } : { right: ANSWER_BUTTON_GAP_WIDE }}
                                onMouseEnter={() => (answerOptionAHovered = true)}
                                onMouseLeave={() => (answerOptionAHovered = false)}
                                onMouseDown={() => roundManager.selectOption('A')}
                            />
                            <AnswerOptionButton
                                text={activeQuestion.optionB}
                                fontSize={answerFontSize(activeQuestion.optionB, compact)}
                                compact={compact}
                                state="interactive"
                                hovered={answerOptionBHovered}
                                margin={compact ? { left: ANSWER_BUTTON_GAP_COMPACT } : { left: ANSWER_BUTTON_GAP_WIDE }}
                                onMouseEnter={() => (answerOptionBHovered = true)}
                                onMouseLeave={() => (answerOptionBHovered = false)}
                                onMouseDown={() => roundManager.selectOption('B')}
                            />
                        </UiEntity>
                    ) : (
                        <UiEntity uiTransform={COLUMN_CENTERED}>
                            <Label
                                value="ANSWER LOCKED"
                                fontSize={compact ? ANSWERING_LOCKED_LABEL_FONT_SIZE_COMPACT : ANSWERING_LOCKED_LABEL_FONT_SIZE_WIDE}
                                color={AGENDA_TEAL}
                                uiTransform={{ margin: { bottom: compact ? ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_COMPACT : ANSWERING_LOCKED_LABEL_MARGIN_BOTTOM_WIDE } }}
                            />
                            <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
                                <AnswerOptionButton
                                    text={activeQuestion.optionA}
                                    fontSize={answerFontSize(activeQuestion.optionA, compact)}
                                    compact={compact}
                                    state={selectedOption === 'A' ? 'selected' : 'unselected'}
                                    hovered={false}
                                    margin={compact ? { right: ANSWER_BUTTON_GAP_COMPACT } : { right: ANSWER_BUTTON_GAP_WIDE }}
                                />
                                <AnswerOptionButton
                                    text={activeQuestion.optionB}
                                    fontSize={answerFontSize(activeQuestion.optionB, compact)}
                                    compact={compact}
                                    state={selectedOption === 'B' ? 'selected' : 'unselected'}
                                    hovered={false}
                                    margin={compact ? { left: ANSWER_BUTTON_GAP_COMPACT } : { left: ANSWER_BUTTON_GAP_WIDE }}
                                />
                            </UiEntity>
                        </UiEntity>
                    )}
                </UiEntity>
            ) : (
                <UiEntity uiTransform={COLUMN_CENTERED}>
                    {isRevealing || !reveal ? (
                        <Label value="REVEALING..." fontSize={32} color={AGENDA_BADGE_BACKGROUND} />
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
const RevealResults = ({
    optionAText,
    optionBText,
    reveal
}: {
    optionAText: string
    optionBText: string
    reveal: RevealData
}) => {
    const wide = getUiScale() >= WIDE_MIN_SCALE
    const maxNames = isMobile() ? REVEAL_MAX_NAMES_MOBILE : wide ? REVEAL_MAX_NAMES_WIDE : REVEAL_MAX_NAMES_COMPACT
    const { opacity, scale } = getResultRevealPresentation()

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
            <Label
                value="RESULTS"
                fontSize={isMobile() ? RESULTS_TITLE_FONT_SIZE_MOBILE : 32}
                color={Color4.create(AGENDA_BADGE_BACKGROUND.r, AGENDA_BADGE_BACKGROUND.g, AGENDA_BADGE_BACKGROUND.b, opacity)}
                // Trimmed 16 -> 6 to help fit the smaller gameplay panel (see
                // GAMEPLAY_PANEL_HEIGHT_WIDE's own doc comment) - still a real gap
                // from the two ResultColumns below, just tighter than before.
                // Mobile-only (isMobile()) bump 6 -> 18: GAMEPLAY_MOBILE_SCALE shrinks
                // the OUTER gameplay panel container, but this internal margin (like
                // every other fixed-pixel value inside RevealResults/ResultColumn) is
                // NOT itself scaled by that - at the smaller mobile panel size the old
                // 6px gap let the ResultColumn cards' top edge cover "RESULTS". Purely
                // this one margin - GAMEPLAY_MOBILE_SCALE, ANSWERING, and the two
                // ResultColumn cards themselves are untouched.
                uiTransform={{ margin: { bottom: isMobile() ? RESULTS_TITLE_MARGIN_BOTTOM_MOBILE : 6 } }}
            />
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
                    opacity={opacity}
                    scale={scale}
                />
                <UiEntity uiTransform={{ width: isMobile() ? RESULTS_CARD_GAP_MOBILE : wide ? 24 : 14 }} />
                <ResultColumn
                    label="B"
                    optionText={optionBText}
                    count={reveal.countB}
                    percent={percentB}
                    entries={entriesB}
                    maxNames={maxNames}
                    nameListRows={requiredRows}
                    wide={wide}
                    opacity={opacity}
                    scale={scale}
                />
            </UiEntity>
        </UiEntity>
    )
}

/**
 * One RESULT option column. Both A and B use identical styling/weight - the
 * shared Social Quest palette (cream/pink/teal/magenta), no green/red, no
 * "winner" treatment - per the "social discovery, not competition" direction.
 * A dedicated per-column "YOUR CHOICE" callout/border accent existed briefly
 * but was retired: the "YOU" badge on the local player's own name row (see
 * the name-list rendering below) already communicates exactly which option
 * they picked, without needing to mark the whole column too. Names are
 * `entry.name`, resolved exactly as before by roundManager's own
 * buildRevealData() (unchanged) - not the separate getDisplayNameFor/
 * Questmate cache the HUD/Agenda/celebrations use, since reveal names were
 * already resolving correctly before this task and this is
 * presentation-only.
 */
const ResultColumn = ({
    label,
    optionText,
    count,
    percent,
    entries,
    maxNames,
    nameListRows,
    wide,
    opacity,
    scale
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
    opacity: number
    scale: number
}) => {
    // Mobile-only third tier - see RESULTS_CARD_*_MOBILE's own doc comment for why this is
    // independent of both `wide` and GAMEPLAY_MOBILE_SCALE. Never affects ANSWERING (this
    // component only renders for RESULT) or desktop (isRealMobileDevice is false there).
    const isRealMobileDevice = isMobile()
    const shown = entries.slice(0, maxNames)
    const remaining = entries.length - shown.length
    const rowHeight = isRealMobileDevice ? RESULTS_CARD_NAME_ROW_HEIGHT_MOBILE : wide ? REVEAL_NAME_ROW_HEIGHT_WIDE : REVEAL_NAME_ROW_HEIGHT_COMPACT
    // Fixed height for nameListRows rows plus the gaps between them (none if there are no rows at all).
    const nameListHeight = nameListRows > 0 ? nameListRows * rowHeight + (nameListRows - 1) * REVEAL_NAME_ROW_GAP : 0

    return (
        <UiEntity
            uiTransform={{
                width: isRealMobileDevice ? RESULTS_CARD_WIDTH_MOBILE : (wide ? 320 : 220) * scale,
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: isRealMobileDevice ? RESULTS_CARD_PADDING_MOBILE : wide ? 18 : 12,
                borderColor: Color4.create(AGENDA_PINK.r, AGENDA_PINK.g, AGENDA_PINK.b, opacity),
                borderWidth: REVEAL_COLUMN_BORDER_WIDTH,
                borderRadius: REVEAL_COLUMN_BORDER_RADIUS
            }}
            uiBackground={{ color: Color4.create(REVEAL_COLUMN_BACKGROUND.r, REVEAL_COLUMN_BACKGROUND.g, REVEAL_COLUMN_BACKGROUND.b, REVEAL_COLUMN_BACKGROUND.a * opacity) }}
        >
            {/* Option title: its own explicit-height wrapper, same reliable technique as the
                name-list fix - the wrapped Label's own measured height isn't trusted, so the
                stats row below is positioned relative to this fixed box instead, regardless of
                whether the title actually renders as 1 or 2 lines. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: isRealMobileDevice ? RESULTS_CARD_TITLE_AREA_HEIGHT_MOBILE : wide ? REVEAL_TITLE_AREA_HEIGHT_WIDE : REVEAL_TITLE_AREA_HEIGHT_COMPACT,
                    alignItems: 'flex-start',
                    margin: { bottom: isRealMobileDevice ? 5 : 8 }
                }}
            >
                <Label
                    value={optionText}
                    fontSize={isRealMobileDevice ? RESULTS_CARD_TITLE_FONT_SIZE_MOBILE : wide ? REVEAL_TITLE_FONT_SIZE_WIDE : REVEAL_TITLE_FONT_SIZE_COMPACT}
                    color={Color4.create(AGENDA_BADGE_BACKGROUND.r, AGENDA_BADGE_BACKGROUND.g, AGENDA_BADGE_BACKGROUND.b, opacity)}
                    textWrap="wrap"
                    uiTransform={{ width: '100%' }}
                />
            </UiEntity>
            {/* Stats row: same fixed-height-wrapper treatment, so it can never overlap the
                names below it either. */}
            <UiEntity
                uiTransform={{
                    width: '100%',
                    height: isRealMobileDevice ? RESULTS_CARD_STATS_ROW_HEIGHT_MOBILE : wide ? REVEAL_STATS_ROW_HEIGHT_WIDE : REVEAL_STATS_ROW_HEIGHT_COMPACT,
                    alignItems: 'flex-start',
                    margin: { bottom: isRealMobileDevice ? 8 : 12 }
                }}
            >
                <Label
                    value={`${count} PLAYER${count === 1 ? '' : 'S'} · ${percent}%`}
                    fontSize={isRealMobileDevice ? RESULTS_CARD_STATS_FONT_SIZE_MOBILE : wide ? 16 : 13}
                    color={Color4.create(CREAM_PANEL_TEXT_MUTED.r, CREAM_PANEL_TEXT_MUTED.g, CREAM_PANEL_TEXT_MUTED.b, opacity)}
                />
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
                    const isLocalPlayer = entry.userId === myProfile.userId
                    return (
                        <UiEntity
                            key={entry.userId}
                            uiTransform={{
                                width: '100%',
                                height: rowHeight,
                                flexDirection: 'row',
                                alignItems: 'center',
                                margin: { bottom: isLastRow ? 0 : REVEAL_NAME_ROW_GAP }
                            }}
                        >
                            <Label
                                value={truncateResultName(entry.name, wide)}
                                fontSize={isRealMobileDevice ? RESULTS_CARD_NAME_FONT_SIZE_MOBILE : wide ? 18 : 14}
                                color={Color4.create(CREAM_PANEL_TEXT_MUTED.r, CREAM_PANEL_TEXT_MUTED.g, CREAM_PANEL_TEXT_MUTED.b, opacity)}
                            />
                            {/* "YOU" badge - purely a comparison against myProfile.userId (already
                                available locally, no new network call, no change to entry.name/
                                buildRevealData) - "rápido de reconocer" per explicit instruction. */}
                            {isLocalPlayer && (
                                <UiEntity
                                    uiTransform={{ margin: { left: 6 }, padding: { top: 2, bottom: 2, left: 6, right: 6 }, borderRadius: 6 }}
                                    uiBackground={{ color: Color4.create(AGENDA_BADGE_BACKGROUND.r, AGENDA_BADGE_BACKGROUND.g, AGENDA_BADGE_BACKGROUND.b, opacity) }}
                                >
                                    <Label
                                        value="YOU"
                                        fontSize={isRealMobileDevice ? RESULTS_CARD_YOU_BADGE_FONT_SIZE_MOBILE : wide ? 11 : 9}
                                        color={Color4.create(AGENDA_CREAM.r, AGENDA_CREAM.g, AGENDA_CREAM.b, opacity)}
                                        textWrap="nowrap"
                                    />
                                </UiEntity>
                            )}
                        </UiEntity>
                    )
                })}
                {remaining > 0 && (
                    <UiEntity uiTransform={{ width: '100%', height: rowHeight, alignItems: 'center' }}>
                        <Label
                            value={`+${remaining} MORE`}
                            fontSize={isRealMobileDevice ? RESULTS_CARD_MORE_FONT_SIZE_MOBILE : wide ? 15 : 12}
                            color={Color4.create(CREAM_PANEL_TEXT_MUTED.r, CREAM_PANEL_TEXT_MUTED.g, CREAM_PANEL_TEXT_MUTED.b, opacity)}
                        />
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
    const baseIconSize = socialAgendaButtonPressed
        ? (wide ? AGENDA_BUTTON_ICON_SIZE_PRESSED_WIDE : AGENDA_BUTTON_ICON_SIZE_PRESSED_COMPACT)
        : active || socialAgendaButtonHovered
          ? (wide ? AGENDA_BUTTON_ICON_SIZE_HOVER_WIDE : AGENDA_BUTTON_ICON_SIZE_HOVER_COMPACT)
          : (wide ? AGENDA_BUTTON_ICON_SIZE_WIDE : AGENDA_BUTTON_ICON_SIZE_COMPACT)
    // Mobile-only post-multiply - see HUD_MOBILE_ICON_SCALE's own doc comment.
    const iconSize = isMobile() ? baseIconSize * HUD_MOBILE_ICON_SCALE : baseIconSize
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
 *
 * Illustrated-panel pass: the flat dark rectangle and its own opaque header
 * bar are both gone, replaced by the SOCIAL_AGENDA_PANEL_PATH background
 * image (SOCIAL AGENDA title, rings, tabs, "Friends" note all baked in) plus
 * the AGENDA_SAFE_AREA_* percentage box for every dynamic element - see this
 * task's report for the pixel-sampled safe-area measurement that box is
 * based on. No connectionsManager/friendshipManager/compatibilityManager/
 * socialNotificationsManager/profilePictureManager call changed, and
 * agendaRevealedConnectionIds' reveal-scoped-to-one-opening lifecycle is
 * untouched - only how their results are painted.
 */
const SocialAgenda = ({ wide, compactUi }: { wide: boolean; compactUi: boolean }) => {
    const allConnections = getAllConnections()
    /**
     * Panel sizing uses `isMobile()` directly - NOT the `compactUi` prop
     * (isMobile() || !wide) - deliberately different from every other use of
     * `compactUi` in this component (row typography still uses it,
     * unchanged). `compactUi` goes true on ANY narrow canvas, including a
     * small desktop preview window - correct for "should this text be
     * smaller," wrong for "should this panel switch to a percentage-of-real-
     * device-width," which should only happen on an actual phone. See
     * getMobileAgendaPanelSize's own doc comment for why real mobile now
     * needs its own computed size rather than a bare percentage string, now
     * that the panel is a fixed-aspect-ratio background image.
     */
    const isRealMobileDevice = isMobile()
    /**
     * A narrow/cramped DESKTOP window - NOT a real phone. Real-device
     * feedback: at this combination, rows/text/affinity/tier/shared-answers/
     * rounds were overlapping on BOTH pages at AGENDA_ROWS_PER_PAGE=4 - the
     * same panel (AGENDA_PANEL_WIDTH_COMPACT/HEIGHT_COMPACT are literally
     * identical to their _WIDE counterparts - this panel never resizes for
     * desktop COMPACT) rendered at a much smaller absolute canvas scale than
     * COMPACT was validated at, without a smaller-than-COMPACT font/row tier
     * to fall back to. Rather than shrinking fonts further (risks legibility,
     * the opposite of the goal), this reuses the exact same lever that
     * already fixed the equivalent mobile overlap (6 -> 5 -> 4
     * rows-per-page): fewer rows per page, same COMPACT fonts/spacing,
     * unchanged.
     *
     * DETECTION, third pass: uses `getUiScale()` directly against a
     * SocialAgenda-specific threshold (AGENDA_DESKTOP_NARROW_SCALE_THRESHOLD
     * = 0.80), not WIDE_MIN_SCALE (0.65) and not the earlier width/height
     * split (which was mathematically just WIDE_MIN_SCALE in disguise).
     * Real-device measurement via the temp diagnostic label, taken exactly
     * at the window size where rows visibly overlapped: uiScale = 0.728,
     * width = 1398, height = 826 - both width and height were comfortably
     * ABOVE the old 1248/702 breakpoints at that size, so that check
     * reported "not narrow" at a size that was already broken. 0.65 (and
     * its width/height-derived equivalents) is simply too low a bar FOR
     * THIS SPECIFIC PANEL - AGENDA_PANEL_WIDTH_COMPACT/HEIGHT_COMPACT never
     * shrink between WIDE/COMPACT the way most other panels in this file
     * do, so it needs its own, higher threshold, not the shared one every
     * other `wide`-driven decision in this file still correctly uses.
     * `getUiScale()` is read fresh every render (this whole UI tree
     * re-renders every frame - see setupUi), so resizing the window flips
     * this immediately. Mobile (isRealMobileDevice true) and a desktop
     * window genuinely at or above 0.80 are both unaffected either way.
     *
     * SECOND CAUSE (real-device evidence, a separate screenshot): even at a
     * genuinely wide/tall window, the REVEAL banner ("NEW CONNECTION! ...
     * joined your Social Agenda") is a normal (non-absolute) flex child that
     * pushes every row below it down by its own real height (padding + 2
     * text lines + margin-bottom - see its own JSX a few hundred lines
     * below) - AGENDA_ROWS_PER_PAGE=4 was sized for the safe area WITHOUT
     * that banner ever eating into it. `hasAgendaBanner` reuses
     * agendaRevealedConnectionIds.length > 0 - the EXACT existing state
     * that already controls the banner's own visibility (see its own JSX) -
     * never a new/duplicated flag. Desktop-only (mobile is completely
     * unaffected - `hasAgendaBanner` is always false there), same
     * `!isRealMobileDevice` gate as isDesktopNarrow.
     */
    const isDesktopNarrow = !isRealMobileDevice && getUiScale() < AGENDA_DESKTOP_NARROW_SCALE_THRESHOLD
    const hasAgendaBanner = !isRealMobileDevice && agendaRevealedConnectionIds.length > 0
    const rowsPerPage = isDesktopNarrow || hasAgendaBanner ? AGENDA_ROWS_PER_PAGE_DESKTOP_NARROW : AGENDA_ROWS_PER_PAGE
    const totalPages = Math.max(1, Math.ceil(allConnections.length / rowsPerPage))
    // Clamp for when rowsPerPage (and so totalPages) shrinks out from under the
    // page the user is already on - narrow/banner toggling on or off mid-view.
    // A direct reassignment of the same module-level `let` socialAgendaPage
    // already used everywhere else in this component (see its own declaration),
    // not React state - this whole tree re-renders every frame regardless (see
    // setupUi), so this needs no extra effect/rerender trigger, and it's a no-op
    // once the page is back in range (only ever lowers it, never bumps a still-
    // valid page).
    if (socialAgendaPage > totalPages - 1) {
        socialAgendaPage = Math.max(0, totalPages - 1)
    }
    const pageStart = socialAgendaPage * rowsPerPage
    const pageEntries = allConnections.slice(pageStart, pageStart + rowsPerPage)
    const canGoPrevious = socialAgendaPage > 0
    const canGoNext = socialAgendaPage < totalPages - 1

    const panelSize = isRealMobileDevice
        ? getMobileAgendaPanelSize()
        : {
              width: wide ? AGENDA_PANEL_WIDTH_WIDE : AGENDA_PANEL_WIDTH_COMPACT,
              height: wide ? AGENDA_PANEL_HEIGHT_WIDE : AGENDA_PANEL_HEIGHT_COMPACT
          }

    const close = () => {
        socialAgendaOpen = false
    }

    return (
        <UiEntity
            uiTransform={{ width: panelSize.width, height: panelSize.height }}
            uiBackground={{ texture: { src: SOCIAL_AGENDA_PANEL_PATH }, textureMode: 'stretch' }}
        >
            {/* Safe area: the pixel-sampled cream rectangle (see AGENDA_SAFE_AREA_*'s own
                doc comment), positioned as an absolute box so every dynamic element scales
                with the panel identically across WIDE/COMPACT/mobile. Holds everything
                dynamic - the baked "SOCIAL AGENDA" title/star and the "Friends" note live
                outside this box, in the image itself, never re-rendered here. */}
            <UiEntity
                uiTransform={{
                    positionType: 'absolute',
                    position: { top: AGENDA_SAFE_AREA_TOP_PERCENT, left: AGENDA_SAFE_AREA_LEFT_PERCENT },
                    width: AGENDA_SAFE_AREA_WIDTH_PERCENT,
                    height: AGENDA_SAFE_AREA_HEIGHT_PERCENT,
                    flexDirection: 'column',
                    padding: { top: 4, bottom: 8, left: 6, right: 6 }
                }}
            >
                {/* Dynamic close control - the ONLY header element left. "SOCIAL AGENDA" and
                    its star accent are baked into the panel image now, so they're not
                    re-rendered here (that would duplicate the title). Small and top-right,
                    clear of both the baked title and the "Friends" note above it (see
                    report for the measured clearance) - a big invisible header-wide tap
                    zone (like the old opaque header bar had) was deliberately skipped: this
                    task can't live-verify exact pill-shape bounds in a running preview, and
                    a wrongly-guessed invisible zone risks either blocking taps on content
                    below it or missing the tap entirely - a small precise button is the
                    reliable choice. */}
                <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, right: 0 }, padding: 10 }} onMouseDown={close}>
                    <Label value="✕" fontSize={wide ? 20 : 17} color={AGENDA_BADGE_BACKGROUND} />
                </UiEntity>

                {allConnections.length === 0 ? (
                    <UiEntity uiTransform={{ ...COLUMN_CENTERED, height: '100%', justifyContent: 'center' }}>
                        {/* Copy unchanged from the already-shipped empty state - only color changed (magenta/muted-plum, matching the illustrated redesign). */}
                        <Label value="No Connections yet." fontSize={20} color={AGENDA_BADGE_BACKGROUND} uiTransform={{ margin: { bottom: 8 } }} />
                        <Label
                            value="Play Social Quest with someone to make your first Connection."
                            fontSize={16}
                            color={CREAM_PANEL_TEXT_MUTED}
                            textAlign="middle-center"
                            textWrap="wrap"
                        />
                    </UiEntity>
                ) : (
                    <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', height: isDesktopNarrow ? '100%' : undefined }}>
                        <Label
                            value={`${allConnections.length} CONNECTION${allConnections.length === 1 ? '' : 'S'}`}
                            fontSize={AGENDA_COUNT_FONT_SIZE}
                            color={AGENDA_BADGE_BACKGROUND}
                            uiTransform={{ margin: { top: 6, bottom: 14 } }}
                        />
                        {/* REVEAL banner - scoped to THIS opening only (agendaRevealedConnectionIds
                            is reset to [] the moment Agenda closes, see uiMenu's own per-frame
                            check), never persisted. Same display-name resolution priority as each
                            row below (a currently-observable name wins over the persisted one,
                            which wins over the generic fallback) - no extra profile requests, just
                            the data this panel already has. Names beyond MAX_CELEBRATION_NAMES
                            collapse into "+N more" (own join here - the HUD toasts above no longer
                            list multiple names at all, so there's nothing shared to reuse). Visual
                            treatment: a soft pink-wash note card (no solid dark fill) so it reads
                            as part of the cream page rather than a separate opaque box - lives
                            entirely inside the safe area, so it can never cover the baked title. */}
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
                                        uiBackground={{ color: Color4.create(AGENDA_PINK.r, AGENDA_PINK.g, AGENDA_PINK.b, 0.12) }}
                                    >
                                        <Label value={headerText} fontSize={wide ? 18 : 15} color={AGENDA_BADGE_BACKGROUND} />
                                        <Label
                                            value={`${namesText} joined your Social Agenda`}
                                            fontSize={wide ? 15 : 13}
                                            color={CREAM_PANEL_TEXT_MUTED}
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
                            // Mobile gets its own (slightly larger) tier, checked before compactUi -
                            // see AGENDA_NAME_FONT_SIZE_MOBILE's own doc comment for why this is a
                            // separate real-device signal, not a change to the compactUi tier itself.
                            const nameFontSize = isRealMobileDevice
                                ? AGENDA_NAME_FONT_SIZE_MOBILE
                                : compactUi
                                  ? AGENDA_NAME_FONT_SIZE_COMPACT
                                  : AGENDA_NAME_FONT_SIZE_WIDE
                            const secondaryFontSize = isRealMobileDevice
                                ? AGENDA_SECONDARY_FONT_SIZE_MOBILE
                                : compactUi
                                  ? AGENDA_SECONDARY_FONT_SIZE_COMPACT
                                  : AGENDA_SECONDARY_FONT_SIZE_WIDE
                            const tertiaryFontSize = isRealMobileDevice
                                ? AGENDA_TERTIARY_FONT_SIZE_MOBILE
                                : compactUi
                                  ? AGENDA_TERTIARY_FONT_SIZE_COMPACT
                                  : AGENDA_TERTIARY_FONT_SIZE_WIDE
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
                                                borderColor: AGENDA_PINK,
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
                                                <Label value={name} fontSize={nameFontSize} color={AGENDA_BADGE_BACKGROUND} />
                                                {isNewRow && (
                                                    <UiEntity
                                                        uiTransform={{ margin: { left: 8 }, padding: { top: 2, bottom: 2, left: 6, right: 6 }, borderRadius: 6 }}
                                                        uiBackground={{ color: AGENDA_BADGE_BACKGROUND }}
                                                    >
                                                        <Label value="NEW" fontSize={compactUi ? 10 : 11} color={AGENDA_CREAM} />
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
                                                <Label
                                                    value={affinity.primary}
                                                    fontSize={secondaryFontSize}
                                                    color={
                                                        affinity.secondary
                                                            ? isRealMobileDevice
                                                                ? AGENDA_MOBILE_AFFINITY_COLOR
                                                                : AGENDA_PINK
                                                            : isRealMobileDevice
                                                              ? AGENDA_MOBILE_MUTED_COLOR
                                                              : CREAM_PANEL_TEXT_MUTED
                                                    }
                                                    textWrap="wrap"
                                                />
                                                {affinity.secondary && (
                                                    <Label
                                                        value={` · ${affinity.secondary}`}
                                                        fontSize={secondaryFontSize}
                                                        color={isRealMobileDevice ? AGENDA_MOBILE_MUTED_COLOR : CREAM_PANEL_TEXT_MUTED}
                                                        textWrap="wrap"
                                                    />
                                                )}
                                            </UiEntity>
                                            {/* Line 3: Friendship level (teal, its own bit of personality) +
                                                rounds together (muted) - only once a level exists at all (a
                                                brand new Connection has none yet, same as before). */}
                                            {level !== null && (
                                                <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: 4 } }}>
                                                    <Label
                                                        value={`✦ ${level}`}
                                                        fontSize={tertiaryFontSize}
                                                        color={isRealMobileDevice ? AGENDA_MOBILE_TIER_COLOR : AGENDA_TEAL}
                                                        textWrap="wrap"
                                                    />
                                                    <Label
                                                        value=" · "
                                                        fontSize={tertiaryFontSize}
                                                        color={isRealMobileDevice ? AGENDA_MOBILE_MUTED_COLOR : CREAM_PANEL_TEXT_MUTED}
                                                    />
                                                    <Label
                                                        value={`${connection.roundsTogether} ROUND${connection.roundsTogether === 1 ? '' : 'S'}`}
                                                        fontSize={tertiaryFontSize}
                                                        color={isRealMobileDevice ? AGENDA_MOBILE_MUTED_COLOR : CREAM_PANEL_TEXT_MUTED}
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

                        {/* Desktop-narrow only: absorbs all leftover vertical space in the now
                            height:'100%' content column, pushing the PREV/NEXT strip down into
                            its own block at the bottom of the safe area instead of sitting
                            directly under the last row. minHeight guarantees a real gap even
                            when the page is full and there's little space left to absorb. Wide/
                            mobile render nothing here - unchanged from before this fix. */}
                        {isDesktopNarrow && <UiEntity uiTransform={{ width: '100%', flexGrow: 1, minHeight: AGENDA_DESKTOP_NARROW_FOOTER_MIN_GAP }} />}

                        {totalPages > 1 && (
                            <UiEntity
                                uiTransform={{
                                    width: '100%',
                                    flexDirection: 'row',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    margin: isDesktopNarrow
                                        ? { top: 8, bottom: AGENDA_DESKTOP_NARROW_FOOTER_BOTTOM_MARGIN }
                                        : { top: AGENDA_FOOTER_TOP_MARGIN }
                                }}
                            >
                                {/* "Tab"-styled pagination pills - soft pink wash, rounded like the pastel
                                    tabs on the illustrated panel's own right edge, code-only (no new asset). */}
                                <UiEntity
                                    uiTransform={{ padding: { top: 8, bottom: 8, left: 14, right: 14 }, borderRadius: 12 }}
                                    uiBackground={{ color: Color4.create(AGENDA_PINK.r, AGENDA_PINK.g, AGENDA_PINK.b, canGoPrevious ? 0.35 : 0.15) }}
                                    onMouseDown={() => {
                                        if (canGoPrevious) socialAgendaPage -= 1
                                    }}
                                >
                                    <Label value="PREV" fontSize={14} color={canGoPrevious ? AGENDA_BADGE_BACKGROUND : CREAM_PANEL_TEXT_MUTED} />
                                </UiEntity>
                                <Label value={`${socialAgendaPage + 1} / ${totalPages}`} fontSize={14} color={CREAM_PANEL_TEXT_MUTED} />
                                <UiEntity
                                    uiTransform={{ padding: { top: 8, bottom: 8, left: 14, right: 14 }, borderRadius: 12 }}
                                    uiBackground={{ color: Color4.create(AGENDA_PINK.r, AGENDA_PINK.g, AGENDA_PINK.b, canGoNext ? 0.35 : 0.15) }}
                                    onMouseDown={() => {
                                        if (canGoNext) socialAgendaPage += 1
                                    }}
                                >
                                    <Label value="NEXT" fontSize={14} color={canGoNext ? AGENDA_BADGE_BACKGROUND : CREAM_PANEL_TEXT_MUTED} />
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

// -----------------------------------------------------------------------
// CELEBRATION VISUAL TIER SYSTEM - purely presentational, layered entirely on
// top of the already-validated capture/dedup/duration logic in
// socialCelebrationQueue.ts/connectionCelebration.ts/friendshipCelebration.ts,
// which this section only ever READS from (getPresentedCelebration(), the two
// CELEBRATION_TICKS constants) and never writes back to. NewConnectionToast/
// FriendshipToast further below stay the only two places that resolve a
// celebration's title/name/bonus text; CelebrationCard is the only place that
// decides how a tier actually looks and animates.
// -----------------------------------------------------------------------

type CelebrationTier = 1 | 2 | 3

/**
 * Maps each Friendship milestone's stable id (never the display string, never
 * a hardcoded rank number) to a visual intensity tier. A future milestone
 * needs only one more entry here - no other file changes.
 */
const CELEBRATION_TIER_BY_MILESTONE_ID: Record<FriendshipMilestoneId, CelebrationTier> = {
    NEW_CONNECTION: 1,
    SPARK: 1,
    FAMILIAR_FACE: 1,
    FRIENDS: 2,
    CLOSE_FRIENDS: 2,
    COSMIC_BOND: 3,
    FRIENDS_FOREVER: 3
}

/**
 * Resolves the visual tier for a presented celebration - a pure function of
 * already-available data, never a new field on any payload. NEW_CONNECTION is
 * always Tier 1 (that payload has no `level` field, but by definition it's
 * always exactly the NEW_CONNECTION milestone). `level === null` (several
 * partners crossed DIFFERENT levels in the same tick - see
 * friendshipCelebration.ts's own buildSnapshot doc comment) has no single
 * resolvable tier either, so it falls back to Tier 1 - the smallest,
 * least-presumptuous container - rather than guessing.
 */
function resolveCelebrationTier(data: PresentedSocialCelebration): CelebrationTier {
    if (data.type === 'NEW_CONNECTION') return 1
    if (data.level === null) return 1
    const definition = FRIENDSHIP_LEVELS.find((level) => level.level === data.level)
    return definition ? CELEBRATION_TIER_BY_MILESTONE_ID[definition.id] : 1
}

/**
 * Pop/exit timing per tier (seconds) - shared by EVERY tier regardless of how
 * it renders (Tier 1's real PNG asset below, or Tier 2/3's still-code-drawn
 * box further down). Split out from the old single per-tier visuals table so
 * the Tier 1 asset swap could remove its now-unused box-drawing fields
 * without touching timing/lifecycle at all - values themselves unchanged.
 */
const CELEBRATION_TIMING: Record<CelebrationTier, { popSeconds: number; exitSeconds: number }> = {
    1: { popSeconds: 0.18, exitSeconds: 0.35 },
    2: { popSeconds: 0.22, exitSeconds: 0.45 },
    3: { popSeconds: 0.28, exitSeconds: 0.5 }
}

/**
 * Tier 1's real visual base - replaces the code-drawn cream box/pink border/
 * circle accents this tier used before. The PNG already bakes in the cream
 * fill, pink frame, and heart/candy/teal-dot decoration; code only overlays
 * the three text lines.
 *
 * Confirmed via the file's own raw PNG header (never assumed): exactly
 * 2172x724, a true 3:1 aspect ratio, RGBA with alpha. WIDTH_WIDE/COMPACT below
 * are both exact multiples of that ratio (HEIGHT is always WIDTH / ratio), so
 * the artwork is never stretched/deformed.
 *
 * The decoration (a large heart top-left, a smaller heart + two teal dots
 * just under it, two teal dots top-right, a candy bottom-right) occupies
 * roughly the outer 16% of the width on each side, confirmed by visually
 * inspecting the asset - CELEBRATION_TIER1_TEXT_ZONE_WIDTH_PERCENT is the
 * clean 68% left over in the middle, where CelebrationCard centers the text.
 */
const CELEBRATION_TIER1_ASSET_PATH = 'assets/images/social-celebration-tier1.png'
const CELEBRATION_TIER1_ASPECT_RATIO = 2172 / 724
const CELEBRATION_TIER1_WIDTH_WIDE = 240
const CELEBRATION_TIER1_WIDTH_COMPACT = 192
const CELEBRATION_TIER1_HEIGHT_WIDE = CELEBRATION_TIER1_WIDTH_WIDE / CELEBRATION_TIER1_ASPECT_RATIO
const CELEBRATION_TIER1_HEIGHT_COMPACT = CELEBRATION_TIER1_WIDTH_COMPACT / CELEBRATION_TIER1_ASPECT_RATIO
const CELEBRATION_TIER1_TEXT_ZONE_WIDTH_PERCENT = '68%'
/**
 * Content is now always exactly TITLE + BONUS SP (no name/subtitle line - see
 * CelebrationCard's own `name` prop, kept but currently never passed a
 * non-null value by any adapter, per explicit "no names" product decision).
 * With only 2 rows guaranteed instead of up to 3, there's real headroom
 * inside the 80/64px-tall card, so these are sized UP from the original
 * 3-row pass rather than kept small - this is also what fixes the earlier
 * "title too high / bonus spilling below the asset" visual bug: that was
 * this same 2-row content trying to center inside spacing tuned for a
 * 3-row worst case.
 */
const CELEBRATION_TIER1_TITLE_FONT_SIZE_WIDE = 18
const CELEBRATION_TIER1_TITLE_FONT_SIZE_COMPACT = 15
const CELEBRATION_TIER1_NAME_FONT_SIZE_WIDE = 12
const CELEBRATION_TIER1_NAME_FONT_SIZE_COMPACT = 10
const CELEBRATION_TIER1_BONUS_FONT_SIZE_WIDE = 16
const CELEBRATION_TIER1_BONUS_FONT_SIZE_COMPACT = 13
/**
 * Gap between TITLE and BONUS SP in the (now permanent) no-name 2-row case -
 * a NEGATIVE margin, deliberately: each Label's own line-box carries more
 * built-in vertical whitespace above/below its glyphs than the visible text
 * needs, so a small negative value eats into that whitespace to pull the two
 * lines into a visually tighter, more compact block, rather than adding real
 * empty space between them. Both rows sit inside a `justifyContent: 'center'`
 * column, so shrinking the gap this way automatically nudges TITLE down and
 * BONUS up in tandem while keeping the pair centered as a whole - no separate
 * per-label offset needed.
 */
const CELEBRATION_TIER1_BONUS_MARGIN_TOP_WIDE = -4
const CELEBRATION_TIER1_BONUS_MARGIN_TOP_COMPACT = -3

/**
 * Tier 2's real visual base - replaces the code-drawn cream box/gold border/
 * accent circle this tier used before (same swap already done for Tier 1).
 * The PNG already bakes in the cream fill, double gold frame, pink base,
 * left medallion with two hearts + ribbons + sparkles, and right heart/
 * sparkle cluster; code only overlays TITLE + BONUS SP.
 *
 * Confirmed via the file's own raw PNG header (never assumed): 1983x793,
 * aspect ratio exactly 1983/793 (~2.5) - WIDTH_WIDE/COMPACT below are both
 * divided by that exact ratio for HEIGHT, so the artwork is never stretched.
 *
 * Unlike Tier 1's symmetric decoration, Tier 2's clean cream zone is NOT
 * centered: the left medallion cluster is visually wider (~30% of the width)
 * than the right heart/sparkle cluster (~14%), confirmed by inspecting the
 * asset - so the safe text zone is positioned with LEFT_PERCENT (not just
 * centered via a percentage width) to sit inside the actually-clean space
 * rather than the card's raw geometric center.
 */
const CELEBRATION_TIER2_ASSET_PATH = 'assets/images/social-celebration-tier2.png'
const CELEBRATION_TIER2_ASPECT_RATIO = 1983 / 793
const CELEBRATION_TIER2_WIDTH_WIDE = 260
const CELEBRATION_TIER2_WIDTH_COMPACT = 205
const CELEBRATION_TIER2_HEIGHT_WIDE = CELEBRATION_TIER2_WIDTH_WIDE / CELEBRATION_TIER2_ASPECT_RATIO
const CELEBRATION_TIER2_HEIGHT_COMPACT = CELEBRATION_TIER2_WIDTH_COMPACT / CELEBRATION_TIER2_ASPECT_RATIO
const CELEBRATION_TIER2_TEXT_ZONE_LEFT_PERCENT = '30%'
const CELEBRATION_TIER2_TEXT_ZONE_WIDTH_PERCENT = '56%'
/**
 * Vertical safe area - deliberately smaller than the full 100% height (unlike
 * Tier 1) and split into two EXPLICIT, EQUAL-HEIGHT rows (see the tier===2
 * branch's own JSX) rather than relying on a margin between two Labels
 * stacked in a centered column. A margin-based gap didn't work here: each
 * Label's own line-box reserves more vertical space than its visible glyphs
 * need, and no margin value (positive or negative) reliably compensated for
 * it - the previous CELEBRATION_TIER2_BONUS_MARGIN_TOP_* constants are gone.
 * This structural 2-row split makes TITLE's and BONUS's positions a direct,
 * predictable function of the safe area's own top/height, immune to either
 * Label's line-box quirks.
 */
const CELEBRATION_TIER2_TEXT_ZONE_TOP_PERCENT_WIDE = '20%'
const CELEBRATION_TIER2_TEXT_ZONE_HEIGHT_PERCENT_WIDE = '60%'
const CELEBRATION_TIER2_TEXT_ZONE_TOP_PERCENT_COMPACT = '19%'
const CELEBRATION_TIER2_TEXT_ZONE_HEIGHT_PERCENT_COMPACT = '62%'
/** Bigger than Tier 1's (18/15 WIDE/COMPACT) - "algo más de presencia", and the taller card leaves real room for it. */
const CELEBRATION_TIER2_TITLE_FONT_SIZE_WIDE = 22
const CELEBRATION_TIER2_TITLE_FONT_SIZE_COMPACT = 18
/**
 * Smaller variant used only for long titles ("CLOSE FRIENDS!", 14 chars, vs
 * "FRIENDS!"'s 8) - see getCelebrationTitleFontSize below. Conservative first
 * pass (lower end of the requested 18-19/15-16 range) so the longer title
 * comfortably clears Tier 2's own 56%-wide safe area without wrapping or
 * invading the medallion/hearts - can be nudged up after visual QA if there's
 * room to spare.
 */
const CELEBRATION_TIER2_TITLE_FONT_SIZE_LONG_WIDE = 18
const CELEBRATION_TIER2_TITLE_FONT_SIZE_LONG_COMPACT = 15
/** Bigger than Tier 1's bonus (16/13 WIDE/COMPACT) - "suficientemente grande para sentirse como reward". */
const CELEBRATION_TIER2_BONUS_FONT_SIZE_WIDE = 19
const CELEBRATION_TIER2_BONUS_FONT_SIZE_COMPACT = 15
/**
 * Nudges ONLY the bonus row up a few px via relative-position offset (never
 * removed from flex flow, never a margin on the Label itself - see the
 * tier===2 branch's own JSX) - TITLE's row is completely untouched by this.
 * A small remaining visual imbalance after the row-split fix: BONUS still
 * read slightly low within its own row's centered space.
 */
const CELEBRATION_TIER2_BONUS_ROW_OFFSET_Y_WIDE = -4
const CELEBRATION_TIER2_BONUS_ROW_OFFSET_Y_COMPACT = -3

/**
 * Small, purely-visual length-based font-size step for celebration titles -
 * same per-character-length-threshold idiom already used by answerFontSize
 * for the answer buttons. Reads only the already-resolved title STRING's
 * length; never touches FRIENDSHIP_LEVELS, milestone ids, or any gameplay
 * data. Tier 1's similarly-long "FAMILIAR FACE!" (14 chars) already fits fine
 * at its own approved base size, so Tier 1 has no "long" variant and stays
 * fully untouched here. Tier 2 ("CLOSE FRIENDS!", 14 chars) and Tier 3
 * ("FRIENDS FOREVER!", 16 chars) both do - their own safe areas are narrower
 * relative to their base fonts. "COSMIC BOND!" is exactly 12 chars, so it
 * lands on the `> threshold` boundary and correctly stays at Tier 3's normal
 * size. Extending protection to a future long title is just one more branch
 * here, never a change to FRIENDSHIP_LEVELS or the milestone names
 * themselves.
 */
const CELEBRATION_TITLE_LONG_CHARS_THRESHOLD = 12

function getCelebrationTitleFontSize(tier: CelebrationTier, title: string, wide: boolean): number {
    const isLong = title.length > CELEBRATION_TITLE_LONG_CHARS_THRESHOLD
    if (tier === 2 && isLong) return wide ? CELEBRATION_TIER2_TITLE_FONT_SIZE_LONG_WIDE : CELEBRATION_TIER2_TITLE_FONT_SIZE_LONG_COMPACT
    if (tier === 2) return wide ? CELEBRATION_TIER2_TITLE_FONT_SIZE_WIDE : CELEBRATION_TIER2_TITLE_FONT_SIZE_COMPACT
    if (tier === 3 && isLong) return wide ? CELEBRATION_TIER3_TITLE_FONT_SIZE_LONG_WIDE : CELEBRATION_TIER3_TITLE_FONT_SIZE_LONG_COMPACT
    if (tier === 3) return wide ? CELEBRATION_TIER3_TITLE_FONT_SIZE_WIDE : CELEBRATION_TIER3_TITLE_FONT_SIZE_COMPACT
    return wide ? CELEBRATION_TIER1_TITLE_FONT_SIZE_WIDE : CELEBRATION_TIER1_TITLE_FONT_SIZE_COMPACT
}

/**
 * Tier 3's real visual base - replaces the code-drawn cream box/gold border
 * this tier used before (same swap already done for Tier 1/2). The PNG
 * already bakes in the cream fill, premium double gold frame, a large winged
 * heart medallion with a crown and ribbons on the LEFT, heart clusters +
 * sparkles on the right, AND small sparkle/heart accents along the top and
 * bottom of the frame itself (unlike Tier 1/2, which only had left/right
 * decoration) - code only overlays TITLE + BONUS SP.
 *
 * Confirmed via the file's own raw PNG header (never assumed): 1983x793,
 * same exact ratio as Tier 2's asset (1983/793, ~2.5) - WIDTH_WIDE/COMPACT
 * below are both divided by that exact ratio for HEIGHT, so the artwork is
 * never stretched.
 *
 * Decoration, confirmed by inspecting the asset:
 * - LEFT: the winged heart medallion + crown + ribbons is large, occupying
 *   roughly the outer 31% of the width - noticeably bigger than Tier 2's own
 *   left medallion.
 * - RIGHT: heart clusters + sparkles occupy roughly the outer 14%.
 * - TOP/BOTTOM: small sparkle+heart accents sit directly on the gold frame
 *   line near horizontal center, roughly the top ~9-23% and bottom ~73-82%
 *   of the height - Tier 2 has no equivalent, so Tier 3's vertical safe area
 *   is deliberately smaller/more centered than Tier 2's to clear both.
 */
const CELEBRATION_TIER3_ASSET_PATH = 'assets/images/social-celebration-tier3.png'
const CELEBRATION_TIER3_ASPECT_RATIO = 1983 / 793
const CELEBRATION_TIER3_WIDTH_WIDE = 280
const CELEBRATION_TIER3_WIDTH_COMPACT = 220
const CELEBRATION_TIER3_HEIGHT_WIDE = CELEBRATION_TIER3_WIDTH_WIDE / CELEBRATION_TIER3_ASPECT_RATIO
const CELEBRATION_TIER3_HEIGHT_COMPACT = CELEBRATION_TIER3_WIDTH_COMPACT / CELEBRATION_TIER3_ASPECT_RATIO
/** Nudged right and narrowed from the first pass (32%/54%) - "COSMIC BOND!"'s leading C was crowding the left decoration at 32%. */
const CELEBRATION_TIER3_TEXT_ZONE_LEFT_PERCENT = '34%'
const CELEBRATION_TIER3_TEXT_ZONE_WIDTH_PERCENT = '52%'
/** Smaller/more centered than Tier 2's (20%/60% WIDE, 19%/62% COMPACT) - clears the extra top/bottom sparkle accents this asset has that Tier 2's doesn't. Same explicit 2-row structure as Tier 2 (see the tier===3 branch's own JSX), never a margin between two Labels. */
const CELEBRATION_TIER3_TEXT_ZONE_TOP_PERCENT_WIDE = '24%'
const CELEBRATION_TIER3_TEXT_ZONE_HEIGHT_PERCENT_WIDE = '50%'
const CELEBRATION_TIER3_TEXT_ZONE_TOP_PERCENT_COMPACT = '23%'
const CELEBRATION_TIER3_TEXT_ZONE_HEIGHT_PERCENT_COMPACT = '52%'
/**
 * "más presencia que Tier 2" (whose normal title is 22/18) still holds even
 * after this second nudge down - Tier 3's title stays at least as large as
 * Tier 2's own long-title variant (18/15), never smaller. Two rounds of
 * shrinking so far: 24/19 (first pass) -> 22/18 (after narrowing the safe
 * area) -> 21/17 (this pass) - "COSMIC BOND!" still read slightly large for
 * the safe area at 22/18.
 */
const CELEBRATION_TIER3_TITLE_FONT_SIZE_WIDE = 21
const CELEBRATION_TIER3_TITLE_FONT_SIZE_COMPACT = 17
/**
 * Smaller variant for "FRIENDS FOREVER!" (16 chars, vs "COSMIC BOND!"'s 12 -
 * exactly at CELEBRATION_TITLE_LONG_CHARS_THRESHOLD, so it stays at the
 * normal size) - see getCelebrationTitleFontSize below. Nudged down from the
 * first pass (17/14) for the same reason as the normal size above.
 */
const CELEBRATION_TIER3_TITLE_FONT_SIZE_LONG_WIDE = 16
const CELEBRATION_TIER3_TITLE_FONT_SIZE_LONG_COMPACT = 13
/** Bigger than Tier 2's bonus (19/15 WIDE/COMPACT) - "grande y claramente premium". */
const CELEBRATION_TIER3_BONUS_FONT_SIZE_WIDE = 20
const CELEBRATION_TIER3_BONUS_FONT_SIZE_COMPACT = 16

/**
 * Stable-enough identity for "is this the same celebration still showing, or
 * a new one" - derived purely from the presented data's own visible fields,
 * since neither PresentedNewConnectionCelebration nor
 * PresentedFriendshipCelebration exposes socialCelebrationQueue's internal
 * `${type}:${roundId}` key, and this module never reaches into that queue for
 * it (see file-level "NO TOCAR" list). A late partner merging into an
 * ALREADY-visible celebration (see connectionCelebration.ts/
 * friendshipCelebration.ts's own "merge in place" doc comments) changes this
 * fingerprint and restarts the entrance animation - treated as correct, not a
 * bug: genuinely new information just arrived.
 */
function celebrationFingerprint(data: PresentedSocialCelebration): string {
    if (data.type === 'NEW_CONNECTION') {
        return `NEW_CONNECTION:${[...data.newUserIds].sort().join(',')}`
    }
    return `FRIENDSHIP:${[...data.userIds].sort().join(',')}:${data.level ?? 'null'}`
}

let celebrationFingerprintSeen: string | null = null
let celebrationElapsedSeconds = 0

/**
 * Same architecture as socialPointsFeedback.ts's own POP/HOLD/EXIT
 * accumulator driving SocialPointsValidRoundToast - a dedicated
 * engine.addSystem (registered once from setupUi() above) accumulating
 * elapsed seconds for whatever socialCelebrationQueue currently presents, as
 * this file's own fully independent instance. Reads getPresentedCelebration()
 * only - never writes back to socialCelebrationQueue.ts/
 * connectionCelebration.ts/friendshipCelebration.ts, whose capture/dedup/
 * duration logic this treats as already-validated and untouched.
 */
function tickCelebrationPresentation(dt: number): void {
    const presented = getPresentedCelebration()
    if (presented === null) {
        celebrationFingerprintSeen = null
        celebrationElapsedSeconds = 0
        return
    }
    const fingerprint = celebrationFingerprint(presented)
    if (fingerprint !== celebrationFingerprintSeen) {
        celebrationFingerprintSeen = fingerprint
        celebrationElapsedSeconds = 0
    } else {
        celebrationElapsedSeconds += dt
    }
}

interface ActiveCelebrationPresentation {
    tier: CelebrationTier
    phase: 'pop' | 'hold' | 'exit'
    phaseProgress: number
    elapsedSeconds: number
}

/**
 * Derives the current pop/hold/exit phase from this file's own
 * celebrationElapsedSeconds accumulator - same phase/phaseProgress shape as
 * ActiveSocialPointsReward, deliberately, so CelebrationCard's animation math
 * reads the same way SocialPointsValidRoundToast's already does. Total
 * duration is NEVER hand-duplicated - always the real CELEBRATION_TICKS
 * constant imported from whichever source module owns this celebration type,
 * so this can never drift from the queue's own already-validated timing.
 */
function getActiveCelebrationPresentation(data: PresentedSocialCelebration): ActiveCelebrationPresentation {
    const tier = resolveCelebrationTier(data)
    const totalDurationSeconds = data.type === 'NEW_CONNECTION' ? NEW_CONNECTION_CELEBRATION_TICKS : FRIENDSHIP_CELEBRATION_TICKS
    const { popSeconds, exitSeconds } = CELEBRATION_TIMING[tier]
    const elapsedSeconds = celebrationElapsedSeconds

    if (elapsedSeconds < popSeconds) {
        return { tier, phase: 'pop', phaseProgress: popSeconds > 0 ? elapsedSeconds / popSeconds : 1, elapsedSeconds }
    }
    const exitStart = totalDurationSeconds - exitSeconds
    if (elapsedSeconds >= exitStart) {
        return { tier, phase: 'exit', phaseProgress: exitSeconds > 0 ? Math.min(1, (elapsedSeconds - exitStart) / exitSeconds) : 1, elapsedSeconds }
    }
    const holdDuration = exitStart - popSeconds
    return { tier, phase: 'hold', phaseProgress: holdDuration > 0 ? (elapsedSeconds - popSeconds) / holdDuration : 1, elapsedSeconds }
}

/**
 * Maps phase/phaseProgress to opacity+scale. Tier 1 is a plain lerp (pop
 * suave / fade simple, per the approved spec). Tier 2/3 pop with a small
 * overshoot-then-settle (more pronounced the higher the tier) before holding
 * at rest. Exit is a straight fade for every tier; Tier 2 also eases its
 * scale down slightly ("reducción suave"); Tier 3 fades only - its sparkles
 * carry the rest of the motion (see CelebrationCard's own sparkle rendering).
 */
function getCelebrationVisualState(tier: CelebrationTier, phase: 'pop' | 'hold' | 'exit', phaseProgress: number): { opacity: number; scale: number } {
    if (phase === 'hold') return { opacity: 1, scale: 1 }

    if (phase === 'pop') {
        if (tier === 1) {
            return { opacity: phaseProgress, scale: 0.85 + 0.15 * phaseProgress }
        }
        const overshootScale = tier === 2 ? 1.05 : 1.08
        const startScale = tier === 2 ? 0.75 : 0.7
        const growPortion = 0.7 // first 70% of the pop grows past 1.0 into the overshoot, remaining 30% settles back to 1.0
        if (phaseProgress < growPortion) {
            const t = phaseProgress / growPortion
            return { opacity: Math.min(1, phaseProgress / 0.5), scale: startScale + (overshootScale - startScale) * t }
        }
        const t = (phaseProgress - growPortion) / (1 - growPortion)
        return { opacity: 1, scale: overshootScale + (1 - overshootScale) * t }
    }

    // exit
    return { opacity: 1 - phaseProgress, scale: tier === 2 ? 1 - 0.05 * phaseProgress : 1 }
}

interface CelebrationCardProps {
    tier: CelebrationTier
    title: string
    name: string | null
    bonusText: string | null
    presentation: ActiveCelebrationPresentation
    wide: boolean
}

/**
 * The ONLY place that decides a celebration's size/color/border/decoration/
 * animation. NewConnectionToast/FriendshipToast below only ever resolve their
 * own title/name/bonus strings (same logic as before this pass) and hand
 * them here along with the already-resolved tier - zero visual JSX
 * duplicated between the two celebration types.
 */
const CelebrationCard = ({ tier, title, name, bonusText, presentation, wide }: CelebrationCardProps) => {
    const { opacity, scale } = getCelebrationVisualState(tier, presentation.phase, presentation.phaseProgress)

    if (tier === 1) {
        const baseWidth = wide ? CELEBRATION_TIER1_WIDTH_WIDE : CELEBRATION_TIER1_WIDTH_COMPACT
        const baseHeight = wide ? CELEBRATION_TIER1_HEIGHT_WIDE : CELEBRATION_TIER1_HEIGHT_COMPACT
        const titleFontSize = wide ? CELEBRATION_TIER1_TITLE_FONT_SIZE_WIDE : CELEBRATION_TIER1_TITLE_FONT_SIZE_COMPACT
        const nameFontSize = wide ? CELEBRATION_TIER1_NAME_FONT_SIZE_WIDE : CELEBRATION_TIER1_NAME_FONT_SIZE_COMPACT
        const bonusFontSize = wide ? CELEBRATION_TIER1_BONUS_FONT_SIZE_WIDE : CELEBRATION_TIER1_BONUS_FONT_SIZE_COMPACT

        return (
            // Outer box: the PNG IS the background - no uiBackground.color, no
            // borderColor/borderWidth/borderRadius of our own (all baked into the
            // asset). Same width/height-as-scale pop/exit technique as Tier 2/3
            // below, and the same texture+color-as-tint-alpha fade already proven
            // for SocialPointsValidRoundToast's heart.
            <UiEntity
                uiTransform={{ width: baseWidth * scale, height: baseHeight * scale, justifyContent: 'center', alignItems: 'center' }}
                uiBackground={{ texture: { src: CELEBRATION_TIER1_ASSET_PATH }, textureMode: 'stretch', color: Color4.create(1, 1, 1, opacity) }}
            >
                {/* Clean central zone, free of the asset's own corner decoration - see
                    CELEBRATION_TIER1_TEXT_ZONE_WIDTH_PERCENT's own doc comment. */}
                <UiEntity
                    uiTransform={{
                        width: CELEBRATION_TIER1_TEXT_ZONE_WIDTH_PERCENT,
                        height: '100%',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        alignItems: 'center'
                    }}
                >
                    <Label
                        value={title}
                        fontSize={titleFontSize}
                        color={Color4.create(AGENDA_BADGE_BACKGROUND.r, AGENDA_BADGE_BACKGROUND.g, AGENDA_BADGE_BACKGROUND.b, opacity)}
                        textAlign="middle-center"
                        textWrap="nowrap"
                    />
                    {name !== null && (
                        <Label
                            value={name}
                            fontSize={nameFontSize}
                            color={Color4.create(MUTED.r, MUTED.g, MUTED.b, opacity)}
                            textAlign="middle-center"
                            textWrap="nowrap"
                            uiTransform={{ margin: { top: 2 } }}
                        />
                    )}
                    {bonusText !== null && (
                        <Label
                            value={bonusText}
                            fontSize={bonusFontSize}
                            color={Color4.create(AGENDA_TEAL.r, AGENDA_TEAL.g, AGENDA_TEAL.b, opacity)}
                            textAlign="middle-center"
                            uiTransform={{
                                margin: { top: name !== null ? 3 : wide ? CELEBRATION_TIER1_BONUS_MARGIN_TOP_WIDE : CELEBRATION_TIER1_BONUS_MARGIN_TOP_COMPACT }
                            }}
                        />
                    )}
                </UiEntity>
            </UiEntity>
        )
    }

    if (tier === 2) {
        const baseWidth = wide ? CELEBRATION_TIER2_WIDTH_WIDE : CELEBRATION_TIER2_WIDTH_COMPACT
        const baseHeight = wide ? CELEBRATION_TIER2_HEIGHT_WIDE : CELEBRATION_TIER2_HEIGHT_COMPACT
        const titleFontSize = getCelebrationTitleFontSize(tier, title, wide)
        const bonusFontSize = wide ? CELEBRATION_TIER2_BONUS_FONT_SIZE_WIDE : CELEBRATION_TIER2_BONUS_FONT_SIZE_COMPACT
        const textZoneTop = wide ? CELEBRATION_TIER2_TEXT_ZONE_TOP_PERCENT_WIDE : CELEBRATION_TIER2_TEXT_ZONE_TOP_PERCENT_COMPACT
        const textZoneHeight = wide ? CELEBRATION_TIER2_TEXT_ZONE_HEIGHT_PERCENT_WIDE : CELEBRATION_TIER2_TEXT_ZONE_HEIGHT_PERCENT_COMPACT
        const bonusRowOffsetY = wide ? CELEBRATION_TIER2_BONUS_ROW_OFFSET_Y_WIDE : CELEBRATION_TIER2_BONUS_ROW_OFFSET_Y_COMPACT

        return (
            // Same pattern as Tier 1: the PNG IS the background - no
            // uiBackground.color, no borderColor/borderWidth/borderRadius, no
            // code-drawn accent circle (all baked into the asset - medallion,
            // hearts, ribbons, sparkles). Same width/height-as-scale pop/exit
            // technique, same texture+color-as-tint-alpha fade.
            <UiEntity
                uiTransform={{ width: baseWidth * scale, height: baseHeight * scale, justifyContent: 'center', alignItems: 'center' }}
                uiBackground={{ texture: { src: CELEBRATION_TIER2_ASSET_PATH }, textureMode: 'stretch', color: Color4.create(1, 1, 1, opacity) }}
            >
                {/* Clean zone, free of the asset's own left medallion / right hearts+
                    sparkles (horizontal - see CELEBRATION_TIER2_TEXT_ZONE_LEFT_PERCENT's
                    own doc comment) AND vertically smaller than the full card height
                    (see CELEBRATION_TIER2_TEXT_ZONE_TOP_PERCENT_*'s own doc comment) -
                    split into two EXPLICIT, equal-height rows rather than a margin
                    between two Labels in a centered column, so TITLE/BONUS's positions
                    are a direct, predictable function of this box's own geometry. */}
                <UiEntity
                    uiTransform={{
                        positionType: 'absolute',
                        position: { left: CELEBRATION_TIER2_TEXT_ZONE_LEFT_PERCENT, top: textZoneTop },
                        width: CELEBRATION_TIER2_TEXT_ZONE_WIDTH_PERCENT,
                        height: textZoneHeight,
                        flexDirection: 'column'
                    }}
                >
                    {/* ROW 1 - TITLE, centered in the top half of the safe area. */}
                    <UiEntity uiTransform={{ width: '100%', height: '50%', justifyContent: 'center', alignItems: 'center' }}>
                        <Label
                            value={title}
                            fontSize={titleFontSize}
                            color={Color4.create(AGENDA_BADGE_BACKGROUND.r, AGENDA_BADGE_BACKGROUND.g, AGENDA_BADGE_BACKGROUND.b, opacity)}
                            textAlign="middle-center"
                            textWrap="nowrap"
                        />
                    </UiEntity>
                    {/* ROW 2 - BONUS SP, centered in the bottom half of the safe area. The
                        small `top` offset is a RELATIVE position nudge (positionType stays
                        the Yoga default 'relative', never 'absolute') - it shifts this row
                        visually without removing it from the flex column or touching TITLE's
                        own row at all, and never via a margin on the Label itself. */}
                    <UiEntity
                        uiTransform={{ width: '100%', height: '50%', justifyContent: 'center', alignItems: 'center', position: { top: bonusRowOffsetY } }}
                    >
                        {bonusText !== null && (
                            <Label
                                value={bonusText}
                                fontSize={bonusFontSize}
                                color={Color4.create(AGENDA_TEAL.r, AGENDA_TEAL.g, AGENDA_TEAL.b, opacity)}
                                textAlign="middle-center"
                            />
                        )}
                    </UiEntity>
                </UiEntity>
            </UiEntity>
        )
    }

    // tier === 3 - same asset-based pattern as Tier 1/2. Sparkles are NOT
    // rendered programmatically here (celebrationSparkles is unused/removed) -
    // the asset already has its own baked-in sparkles/hearts/crown, and
    // layering more on top would clutter rather than help; "que prime la
    // limpieza visual" per explicit instruction.
    const baseWidth = wide ? CELEBRATION_TIER3_WIDTH_WIDE : CELEBRATION_TIER3_WIDTH_COMPACT
    const baseHeight = wide ? CELEBRATION_TIER3_HEIGHT_WIDE : CELEBRATION_TIER3_HEIGHT_COMPACT
    const titleFontSize = getCelebrationTitleFontSize(tier, title, wide)
    const bonusFontSize = wide ? CELEBRATION_TIER3_BONUS_FONT_SIZE_WIDE : CELEBRATION_TIER3_BONUS_FONT_SIZE_COMPACT
    const textZoneTop = wide ? CELEBRATION_TIER3_TEXT_ZONE_TOP_PERCENT_WIDE : CELEBRATION_TIER3_TEXT_ZONE_TOP_PERCENT_COMPACT
    const textZoneHeight = wide ? CELEBRATION_TIER3_TEXT_ZONE_HEIGHT_PERCENT_WIDE : CELEBRATION_TIER3_TEXT_ZONE_HEIGHT_PERCENT_COMPACT

    return (
        // Same pattern as Tier 1/2: the PNG IS the background - no
        // uiBackground.color, no borderColor/borderWidth/borderRadius, no
        // code-drawn medallion/hearts/sparkles (all baked into the asset).
        // Same width/height-as-scale pop/exit technique, same
        // texture+color-as-tint-alpha fade.
        <UiEntity
            uiTransform={{ width: baseWidth * scale, height: baseHeight * scale, justifyContent: 'center', alignItems: 'center' }}
            uiBackground={{ texture: { src: CELEBRATION_TIER3_ASSET_PATH }, textureMode: 'stretch', color: Color4.create(1, 1, 1, opacity) }}
        >
            {/* Clean zone, free of the asset's own left medallion/crown/ribbons,
                right hearts+sparkles, AND the extra top/bottom sparkle+heart
                accents this asset has that Tier 2's doesn't - see
                CELEBRATION_TIER3_TEXT_ZONE_*'s own doc comment. Same explicit
                2-row split as Tier 2, never a margin between two Labels. */}
            <UiEntity
                uiTransform={{
                    positionType: 'absolute',
                    position: { left: CELEBRATION_TIER3_TEXT_ZONE_LEFT_PERCENT, top: textZoneTop },
                    width: CELEBRATION_TIER3_TEXT_ZONE_WIDTH_PERCENT,
                    height: textZoneHeight,
                    flexDirection: 'column'
                }}
            >
                {/* ROW 1 - TITLE, centered in the top half of the safe area. */}
                <UiEntity uiTransform={{ width: '100%', height: '50%', justifyContent: 'center', alignItems: 'center' }}>
                    <Label
                        value={title}
                        fontSize={titleFontSize}
                        color={Color4.create(AGENDA_BADGE_BACKGROUND.r, AGENDA_BADGE_BACKGROUND.g, AGENDA_BADGE_BACKGROUND.b, opacity)}
                        textAlign="middle-center"
                        textWrap="nowrap"
                    />
                </UiEntity>
                {/* ROW 2 - BONUS SP, centered in the bottom half of the safe area. */}
                <UiEntity uiTransform={{ width: '100%', height: '50%', justifyContent: 'center', alignItems: 'center' }}>
                    {bonusText !== null && (
                        <Label
                            value={bonusText}
                            fontSize={bonusFontSize}
                            color={Color4.create(AGENDA_TEAL.r, AGENDA_TEAL.g, AGENDA_TEAL.b, opacity)}
                            textAlign="middle-center"
                        />
                    )}
                </UiEntity>
            </UiEntity>
        </UiEntity>
    )
}

/**
 * Adapter for a NEW CONNECTION celebration - resolves title/bonus text (bonus
 * always resolved from FRIENDSHIP_LEVELS by id), then hands the result to the
 * shared CelebrationCard. No name/subtitle line at all, per explicit product
 * decision - names are already browsable in Social Agenda, and the
 * celebration is meant to be read at a glance: TITLE, then BONUS SP.
 */
const NewConnectionToast = ({
    data,
    presentation,
    wide
}: {
    data: PresentedNewConnectionCelebration
    presentation: ActiveCelebrationPresentation
    wide: boolean
}) => {
    const count = data.newUserIds.length
    const titleText = count === 1 ? 'NEW CONNECTION!' : `${count} NEW CONNECTIONS!`
    const bonusAmount = resolveNewConnectionBonusAmount(count)

    return (
        <CelebrationCard
            tier={presentation.tier}
            title={titleText}
            name={null}
            bonusText={`+${bonusAmount} SP`}
            presentation={presentation}
            wide={wide}
        />
    )
}

/**
 * Adapter for a FRIENDSHIP LEVEL UP celebration - resolves title/bonus text
 * (bonus resolved from FRIENDSHIP_LEVELS by `data.level`, multiplied by how
 * many partners reached that SAME level this tick), then hands the result to
 * the shared CelebrationCard. No name/subtitle line at all, per explicit
 * product decision - the aggregated bonus already communicates "more than
 * one" without needing a count-summary line spelled out.
 *
 * `data.level === null` (several partners crossed DIFFERENT levels in the
 * same tick) still renders through CelebrationCard, always at Tier 1 (see
 * resolveCelebrationTier) - just the generic "LEVEL UP!" title, no bonus,
 * same accepted limitation as before this pass.
 */
const FriendshipToast = ({
    data,
    presentation,
    wide
}: {
    data: PresentedFriendshipCelebration
    presentation: ActiveCelebrationPresentation
    wide: boolean
}) => {
    if (data.level === null) {
        return <CelebrationCard tier={presentation.tier} title="LEVEL UP!" name={null} bonusText={null} presentation={presentation} wide={wide} />
    }

    const count = data.userIds.length
    const titleText = `${data.level}!`
    const levelDefinition = FRIENDSHIP_LEVELS.find((level) => level.level === data.level)
    const bonusAmount = levelDefinition ? levelDefinition.bonusPoints * count : null

    return (
        <CelebrationCard
            tier={presentation.tier}
            title={titleText}
            name={null}
            bonusText={bonusAmount !== null ? `+${bonusAmount} SP` : null}
            presentation={presentation}
            wide={wide}
        />
    )
}
