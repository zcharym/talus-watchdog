// The cron path: run a synthetic check against one target, and decide what
// status/incident transition it implies. `applyCheck` is pure (no I/O) so it
// can be unit-tested directly.

import {
  CHECK_TIMEOUT_MS,
  THRESHOLDS,
  type Target,
  type IncidentSeverity,
} from "./config";

export interface CheckResult {
  target: Target;
  status: number | null; // HTTP status, or null on throw/timeout
  latencyMs: number;
  ok: boolean;
  error: string | null; // reason string on failure
}

/** rolling per-component state read from D1 each tick */
export interface ComponentState {
  current_status: string;
  consecutive_failures: number;
  consecutive_successes: number;
}

/** what the cron should do to the incidents table after applying a check */
export type IncidentAction =
  | { type: "none" }
  | { type: "open"; severity: IncidentSeverity; title: string }
  | { type: "escalate"; severity: "major"; title: string }
  | { type: "resolve" };

export interface StatusUpdate {
  current_status: string;
  consecutive_failures: number;
  consecutive_successes: number;
  last_check_at: number;
  incidentAction: IncidentAction;
}

function errorReason(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "AbortError") return "timeout";
    return e.message || e.name;
  }
  return String(e);
}

/**
 * Fetch a target with an AbortController timeout. Captures status, latency,
 * ok, and error per PLAN.md insight 3 ("Down for a Worker has several meanings"):
 *   - throw / timeout          -> Down (ok=false)
 *   - HTTP >= 500              -> Down (ok=false)
 *   - HTTP 4xx                 -> not a crash; ok=true, status recorded
 *   - 2xx/3xx                  -> ok=true
 *   - expectedContent missing  -> "up but broken" (ok=false)
 */
export async function runCheck(target: Target): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(target.url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "talus-watchdog/1.0" },
      cf: { cacheTtl: 0 }, // never serve the probe from Cloudflare's cache
    });
    const latencyMs = Date.now() - start;
    let ok = res.status < 500;
    let error: string | null = null;

    if (target.expectedContent) {
      const body = await res.text();
      if (!body.includes(target.expectedContent)) {
        ok = false;
        error = `content check failed: missing "${target.expectedContent}"`;
      }
    }
    if (res.status >= 500) error = `http ${res.status}`;

    return { target, status: res.status, latencyMs, ok, error };
  } catch (e) {
    return {
      target,
      status: null,
      latencyMs: Date.now() - start,
      ok: false,
      error: errorReason(e),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pure incident-logic: given the component's rolling state and a fresh check,
 * compute the new status, counters, and any incident action.
 *
 * Thresholds (see PLAN.md insight 2):
 *   1 failure             -> log only (status unchanged)
 *   2 consecutive failures -> Degraded (open incident)
 *   5 consecutive failures -> Major Outage (escalate incident)
 *   2 consecutive successes -> Operational (resolve incident)
 */
export function applyCheck(
  state: ComponentState,
  check: CheckResult,
  now: number,
): StatusUpdate {
  let consecutive_failures = state.consecutive_failures;
  let consecutive_successes = state.consecutive_successes;
  let current_status = state.current_status;
  let incidentAction: IncidentAction = { type: "none" };

  if (check.ok) {
    consecutive_failures = 0;
    consecutive_successes += 1;
    if (
      consecutive_successes >= THRESHOLDS.recovery &&
      current_status !== "operational"
    ) {
      current_status = "operational";
      incidentAction = { type: "resolve" };
    }
  } else {
    consecutive_successes = 0;
    consecutive_failures += 1;
    const wasDegradedOrWorse =
      current_status === "degraded" || current_status === "outage";

    if (
      consecutive_failures >= THRESHOLDS.outage &&
      current_status !== "outage"
    ) {
      current_status = "outage";
      const title = `${check.target.name} major outage`;
      incidentAction = wasDegradedOrWorse
        ? { type: "escalate", severity: "major", title }
        : { type: "open", severity: "major", title };
    } else if (
      consecutive_failures >= THRESHOLDS.degraded &&
      (current_status === "operational" || current_status === "unknown")
    ) {
      current_status = "degraded";
      incidentAction = {
        type: "open",
        severity: "degraded",
        title: `${check.target.name} degraded`,
      };
    }
    // 1 failure: status unchanged, check is still logged.
  }

  return {
    current_status,
    consecutive_failures,
    consecutive_successes,
    last_check_at: now,
    incidentAction,
  };
}
