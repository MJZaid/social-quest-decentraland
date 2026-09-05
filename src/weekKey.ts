/**
 * Pure, UTC-only identity for "the current week" - used by Top Matches THIS
 * WEEK (topMatchesWeeklyManager.ts). A week's key is the ISO date
 * (YYYY-MM-DD) of the Monday 00:00:00 UTC that starts it - deliberately NOT
 * an ISO week number (e.g. "2026-W36"): ISO week numbers require correctly
 * handling year-boundary edge cases (a week's own numbering year doesn't
 * always match the calendar year - see ISO 8601's "which week contains the
 * year's first Thursday" rule), which is easy to get subtly wrong. A plain
 * Monday date sidesteps that entire bug class by construction - there is no
 * "week number within a year" to compute, only "which Monday," so there is
 * nothing to get wrong at a year boundary.
 *
 * Never depends on the caller's timezone, the server's local timezone,
 * locale, or DST - every computation here uses UTC getters exclusively.
 */
export function getWeekKey(timestampMs: number): string {
    const date = new Date(timestampMs)
    const utcDayOfWeek = date.getUTCDay() // 0=Sunday, 1=Monday, ..., 6=Saturday
    const daysSinceMonday = (utcDayOfWeek + 6) % 7 // Monday->0, Tuesday->1, ..., Sunday->6
    const mondayUtcMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday)
    const monday = new Date(mondayUtcMs)

    const year = monday.getUTCFullYear()
    const month = String(monday.getUTCMonth() + 1).padStart(2, '0')
    const day = String(monday.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}
