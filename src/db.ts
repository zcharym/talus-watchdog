// D1 data access for talus-watchdog.
// All DB calls are wrapped so a hiccup surfaces as a thrown error the caller
// (index.ts) catches - a DB failure must never kill the whole cron tick.
// (D1Database is an ambient global via `types: ["@cloudflare/workers-types"]`.)

import { TARGETS, type IncidentSeverity } from "./config";
import type { CheckResult, StatusUpdate } from "./checker";

/** a row from the `components` table */
export interface ComponentRow {
  slug: string;
  name: string;
  url: string;
  current_status: string;
  consecutive_failures: number;
  consecutive_successes: number;
  last_check_at: number | null;
}

export interface IncidentRow {
  id: number;
  target: string;
  started_at: number;
  resolved_at: number | null;
  severity: IncidentSeverity;
  title: string | null;
}

/** a single recent check, for the 24h sparkline + uptime + p95 */
export interface CheckDetail {
  ts: number;
  ok: number; // 1/0
  latency_ms: number | null;
}

/** a per-day uptime bucket, for the 90-day bar + 7/30/90d uptime % */
export interface DailyBucket {
  day: string; // 'YYYY-MM-DD' (UTC)
  ok_count: number;
  total: number;
}

/** Make sure every configured target has a components row. Idempotent. */
export async function ensureComponentsSeeded(db: D1Database): Promise<void> {
  for (const t of TARGETS) {
    await db
      .prepare(
        `INSERT INTO components (slug, name, url, current_status, consecutive_failures, consecutive_successes)
         VALUES (?, ?, ?, 'operational', 0, 0)
         ON CONFLICT(slug) DO NOTHING`,
      )
      .bind(t.slug, t.name, t.url)
      .run();
  }
}

export async function getComponent(
  db: D1Database,
  slug: string,
): Promise<ComponentRow | null> {
  return db
    .prepare(
      `SELECT slug, name, url, current_status, consecutive_failures, consecutive_successes, last_check_at
       FROM components WHERE slug = ?`,
    )
    .bind(slug)
    .first<ComponentRow | null>();
}

export async function getComponents(db: D1Database): Promise<ComponentRow[]> {
  const res = await db
    .prepare(
      `SELECT slug, name, url, current_status, consecutive_failures, consecutive_successes, last_check_at
       FROM components ORDER BY slug ASC`,
    )
    .all<ComponentRow>();
  return res.results ?? [];
}

export async function recordCheck(
  db: D1Database,
  check: CheckResult,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO checks (target, ts, status, latency_ms, ok, error, colo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      check.target.slug,
      now,
      check.status,
      check.latencyMs,
      check.ok ? 1 : 0,
      check.error,
      null, // colo isn't exposed in scheduled events; see PLAN.md insight 7
    )
    .run();
}

export async function updateComponent(
  db: D1Database,
  slug: string,
  update: StatusUpdate,
): Promise<void> {
  await db
    .prepare(
      `UPDATE components
       SET current_status = ?, consecutive_failures = ?, consecutive_successes = ?, last_check_at = ?
       WHERE slug = ?`,
    )
    .bind(
      update.current_status,
      update.consecutive_failures,
      update.consecutive_successes,
      update.last_check_at,
      slug,
    )
    .run();
}

export async function openIncident(
  db: D1Database,
  slug: string,
  severity: IncidentSeverity,
  title: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO incidents (target, started_at, severity, title) VALUES (?, ?, ?, ?)`,
    )
    .bind(slug, now, severity, title)
    .run();
}

/** Escalate an existing open incident (degraded -> major). Falls back to
 *  opening one if no open incident exists (defensive). */
export async function escalateIncident(
  db: D1Database,
  slug: string,
  severity: IncidentSeverity,
  title: string,
  now: number,
): Promise<void> {
  const res = await db
    .prepare(
      `UPDATE incidents SET severity = ?, title = ? WHERE target = ? AND resolved_at IS NULL`,
    )
    .bind(severity, title, slug)
    .run();
  if (!res.meta.changes) {
    await openIncident(db, slug, severity, title, now);
  }
}

export async function resolveOpenIncident(
  db: D1Database,
  slug: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE incidents SET resolved_at = ? WHERE target = ? AND resolved_at IS NULL`,
    )
    .bind(now, slug)
    .run();
}

/** checks from the last `sinceMs`, for sparkline + 24h uptime + p95. */
export async function getChecksSince(
  db: D1Database,
  slug: string,
  sinceMs: number,
): Promise<CheckDetail[]> {
  const res = await db
    .prepare(
      `SELECT ts, ok, latency_ms FROM checks
       WHERE target = ? AND ts >= ? ORDER BY ts ASC`,
    )
    .bind(slug, sinceMs)
    .all<CheckDetail>();
  return res.results ?? [];
}

/** per-day uptime buckets for the last `sinceMs`. */
export async function getDailyBucketsSince(
  db: D1Database,
  slug: string,
  sinceMs: number,
): Promise<DailyBucket[]> {
  const res = await db
    .prepare(
      `SELECT
         date(ts / 1000, 'unixepoch') AS day,
         SUM(ok) AS ok_count,
         COUNT(*) AS total
       FROM checks
       WHERE target = ? AND ts >= ?
       GROUP BY day
       ORDER BY day ASC`,
    )
    .bind(slug, sinceMs)
    .all<DailyBucket>();
  return res.results ?? [];
}

export async function getRecentIncidents(
  db: D1Database,
  limit: number,
): Promise<IncidentRow[]> {
  const res = await db
    .prepare(
      `SELECT id, target, started_at, resolved_at, severity, title
       FROM incidents ORDER BY started_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<IncidentRow>();
  return res.results ?? [];
}

/** Update only last_check_at - used in the cron's fallback path when a check
 *  could not be fully processed, so the watchdog still reports it is alive. */
export async function stampLastCheckAt(
  db: D1Database,
  slug: string,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE components SET last_check_at = ? WHERE slug = ?")
    .bind(now, slug)
    .run();
}

/** Prune raw checks older than `beforeMs` (D1 hygiene; called ~hourly). */
export async function pruneOldChecks(
  db: D1Database,
  beforeMs: number,
): Promise<void> {
  await db.prepare(`DELETE FROM checks WHERE ts < ?`).bind(beforeMs).run();
}
