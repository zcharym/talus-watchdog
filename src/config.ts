// Static configuration for talus-watchdog.
// Tunable knobs (targets, thresholds, timeouts) live here so the checker,
// db, and page layers all read from one place.

export interface Target {
  /** component slug; matches components.slug and checks.target */
  slug: string;
  /** human-readable name shown on the status page */
  name: string;
  /** URL the checker hits */
  url: string;
  /** optional: substring expected in the response body (v1.5 content check).
   *  If set, a 200 that omits this string reads as "up but broken" -> failure. */
  expectedContent?: string;
  /** If true, shown on the page but excluded from the overall status badge
   *  (used for always-up control targets). */
  control?: boolean;
}

/**
 * What we monitor in v1.
 * - app.taluship.com : the product Worker (primary)
 * - taluship.com     : apex (secondary)
 * - cloudflare.com   : always-up control, to distinguish "target down" from a
 *                       checker-side network blip
 */
export const TARGETS: Target[] = [
  { slug: "app", name: "Talus Ship App", url: "https://app.taluship.com" },
  { slug: "apex", name: "Talus Ship (apex)", url: "https://taluship.com" },
  {
    slug: "cloudflare",
    name: "Cloudflare (control)",
    url: "https://cloudflare.com",
    control: true,
  },
];

/**
 * Consecutive-failure thresholds (see PLAN.md "A single failed check is noise").
 * A single failure is logged only; status only changes at these thresholds to
 * avoid flapping.
 */
export const THRESHOLDS = {
  /** consecutive failures -> Degraded */
  degraded: 2,
  /** consecutive failures (~5 min at 1-min cadence) -> Major Outage */
  outage: 5,
  /** consecutive successes -> Operational (resolve incident) */
  recovery: 2,
} as const;

/** per-request timeout via AbortController (ms). 8s plan default. */
export const CHECK_TIMEOUT_MS = 8000;

/** Cache API TTL for the rendered page + /api/status JSON (seconds). */
export const PAGE_CACHE_TTL_S = 30;

/** if the newest component.last_check_at is older than this, show the
 *  self-monitor "monitoring may be degraded" banner (ms). */
export const STALE_BANNER_THRESHOLD_MS = 5 * 60 * 1000;

/** raw checks are retained this long (days); older rows are pruned.
 *  The 90-day status view is computed live from `checks`, so this must be >= 90. */
export const RETENTION_DAYS = 90;

export type ComponentStatus = "operational" | "degraded" | "outage" | "unknown";
export type IncidentSeverity = "degraded" | "major";
