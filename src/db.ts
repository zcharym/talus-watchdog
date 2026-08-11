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

function utcDay(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
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
  const day = utcDay(now);
  const okInc = check.ok ? 1 : 0;

  // Atomic: raw check + today's aggregate bump (status page reads aggregates
  // for 7/30/90d — must not wait for the hourly full rollup).
  await db.batch([
    db
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
      ),
    db
      .prepare(
        `INSERT INTO daily_aggregates
           (day, target, uptime_pct, p95_latency_ms, incident_count, ok_count, total)
         VALUES (?, ?, ?, NULL, 0, ?, 1)
         ON CONFLICT(day, target) DO UPDATE SET
           ok_count = ok_count + excluded.ok_count,
           total = total + 1,
           uptime_pct = 100.0 * (ok_count + excluded.ok_count) / (total + 1)`,
      )
      .bind(day, check.target.slug, check.ok ? 100 : 0, okInc),
  ]);
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

/**
 * Per-day uptime buckets from `daily_aggregates` (not a live scan of `checks`).
 * Populated by `rollupDailyAggregates` during hourly compaction.
 */
export async function getDailyBucketsSince(
  db: D1Database,
  slug: string,
  sinceMs: number,
): Promise<DailyBucket[]> {
  const sinceDay = utcDay(sinceMs);
  const res = await db
    .prepare(
      `SELECT day, ok_count, total
       FROM daily_aggregates
       WHERE target = ? AND day >= ?
       ORDER BY day ASC`,
    )
    .bind(slug, sinceDay)
    .all<DailyBucket>();
  return res.results ?? [];
}

/**
 * Roll recent calendar days into `daily_aggregates` so the status page can
 * serve 7/30/90d views without scanning hundreds of thousands of raw checks
 * (D1 bills rows scanned — a live 90d GROUP BY blows free-tier read quotas).
 *
 * Recomputes today + yesterday only (~2 × 1440 rows/target) — call hourly.
 */
export async function rollupDailyAggregates(
  db: D1Database,
  now: number,
): Promise<void> {
  const today = utcDay(now);
  const yesterday = utcDay(now - 86_400_000);
  const days = [yesterday, today];

  for (const target of TARGETS) {
    for (const day of days) {
      const start = dayStartMs(day);
      const end = start + 86_400_000;

      const stats = await db
        .prepare(
          `SELECT
             COALESCE(SUM(ok), 0) AS ok_count,
             COUNT(*) AS total
           FROM checks
           WHERE target = ? AND ts >= ? AND ts < ?`,
        )
        .bind(target.slug, start, end)
        .first<{ ok_count: number; total: number }>();

      const ok_count = Number(stats?.ok_count ?? 0);
      const total = Number(stats?.total ?? 0);
      if (total === 0) continue;

      const latencies = await db
        .prepare(
          `SELECT latency_ms FROM checks
           WHERE target = ? AND ts >= ? AND ts < ? AND latency_ms IS NOT NULL
           ORDER BY latency_ms ASC`,
        )
        .bind(target.slug, start, end)
        .all<{ latency_ms: number }>();
      const vals = (latencies.results ?? []).map((r) => r.latency_ms);
      let p95: number | null = null;
      if (vals.length > 0) {
        const idx = Math.max(
          0,
          Math.min(vals.length - 1, Math.ceil(0.95 * vals.length) - 1),
        );
        p95 = vals[idx];
      }

      const incidents = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM incidents
           WHERE target = ? AND started_at >= ? AND started_at < ?`,
        )
        .bind(target.slug, start, end)
        .first<{ n: number }>();

      const uptime_pct = (ok_count * 100) / total;
      await db
        .prepare(
          `INSERT INTO daily_aggregates
             (day, target, uptime_pct, p95_latency_ms, incident_count, ok_count, total)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, target) DO UPDATE SET
             uptime_pct = excluded.uptime_pct,
             p95_latency_ms = excluded.p95_latency_ms,
             incident_count = excluded.incident_count,
             ok_count = excluded.ok_count,
             total = excluded.total`,
        )
        .bind(
          day,
          target.slug,
          uptime_pct,
          p95,
          Number(incidents?.n ?? 0),
          ok_count,
          total,
        )
        .run();
    }
  }
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
