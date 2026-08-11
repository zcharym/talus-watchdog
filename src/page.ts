// The fetch path: build a status model from D1 and render either the public
// HTML page or the /api/status JSON. All uptime/percentile/format helpers are
// pure so they can be unit-tested.
// (D1Database is an ambient global via `types: ["@cloudflare/workers-types"]`.)

import {
  RETENTION_DAYS,
  STALE_BANNER_THRESHOLD_MS,
  TARGETS,
} from "./config";
import {
  getComponents,
  getChecksSince,
  getDailyBucketsSince,
  getRecentIncidents,
  type IncidentRow,
  type DailyBucket,
} from "./db";

export type OverallStatus = "operational" | "degraded" | "outage" | "unknown";

export interface ComponentView {
  slug: string;
  name: string;
  url: string;
  current_status: string;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  uptime90d: number | null;
  p95_24h_ms: number | null;
  sparkline: { ts: number; latency_ms: number | null }[];
  dailyBars: { day: string; uptime: number | null }[];
}

export interface StatusModel {
  overall: OverallStatus;
  lastCheckAt: number | null;
  stale: boolean;
  generatedAt: number;
  components: ComponentView[];
  incidents: IncidentRow[];
}

// ---------- pure helpers (unit-tested) ----------

export function overallStatus(statuses: string[]): OverallStatus {
  if (statuses.includes("outage")) return "outage";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.includes("unknown")) return "unknown";
  return "operational";
}

export function uptimePct(ok: number, total: number): number | null {
  if (total <= 0) return null;
  return (ok * 100) / total;
}

export function uptimeFromBuckets(
  buckets: DailyBucket[],
  sinceMs: number,
): number | null {
  const cutoff = new Date(sinceMs).toISOString().slice(0, 10);
  let ok = 0;
  let total = 0;
  for (const b of buckets) {
    if (b.day >= cutoff) {
      ok += b.ok_count;
      total += b.total;
    }
  }
  return uptimePct(ok, total);
}

export function p95Latency(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx];
}

export function lastNDays(n: number, now: number): string[] {
  const days: string[] = [];
  const dayMs = 86_400_000;
  for (let i = n - 1; i >= 0; i--) {
    days.push(new Date(now - i * dayMs).toISOString().slice(0, 10));
  }
  return days;
}

export function formatAgo(fromMs: number | null, now: number): string {
  if (fromMs == null) return "never";
  const s = Math.max(0, Math.floor((now - fromMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatDuration(
  fromMs: number,
  toMs: number | null,
  now: number,
): string {
  const end = toMs ?? now;
  const s = Math.max(0, Math.floor((end - fromMs) / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---------- model assembly ----------

function buildDailyBars(
  buckets: DailyBucket[],
  now: number,
  n = 90,
): { day: string; uptime: number | null }[] {
  const byDay = new Map(buckets.map((b) => [b.day, b]));
  return lastNDays(n, now).map((day) => {
    const b = byDay.get(day);
    return { day, uptime: b ? uptimePct(b.ok_count, b.total) : null };
  });
}

export async function buildStatusModel(
  db: D1Database,
  now: number,
): Promise<StatusModel> {
  const components = await getComponents(db);
  const since24h = now - 24 * 3_600_000;
  const since90d = now - RETENTION_DAYS * 86_400_000;

  const views: ComponentView[] = [];
  for (const c of components) {
    const [recent, buckets] = await Promise.all([
      getChecksSince(db, c.slug, since24h),
      getDailyBucketsSince(db, c.slug, since90d),
    ]);
    const latencies = recent
      .map((r) => r.latency_ms)
      .filter((v): v is number => v != null);
    const ok24 = recent.reduce((a, r) => a + r.ok, 0);

    views.push({
      slug: c.slug,
      name: c.name,
      url: c.url,
      current_status: c.current_status,
      uptime24h: uptimePct(ok24, recent.length),
      uptime7d: uptimeFromBuckets(buckets, now - 7 * 86_400_000),
      uptime30d: uptimeFromBuckets(buckets, now - 30 * 86_400_000),
      uptime90d: uptimeFromBuckets(buckets, since90d),
      p95_24h_ms: p95Latency(latencies),
      sparkline: recent.map((r) => ({ ts: r.ts, latency_ms: r.latency_ms })),
      dailyBars: buildDailyBars(buckets, now, 90),
    });
  }

  const incidents = await getRecentIncidents(db, 10);
  const lastCheckAt = components.reduce<number | null>((m, c) => {
    if (c.last_check_at == null) return m;
    return m == null ? c.last_check_at : Math.max(m, c.last_check_at);
  }, null);
  const stale =
    lastCheckAt == null || now - lastCheckAt > STALE_BANNER_THRESHOLD_MS;

  const controlSlugs = new Set(TARGETS.filter((t) => t.control).map((t) => t.slug));
  const productStatuses = components
    .filter((c) => !controlSlugs.has(c.slug))
    .map((c) => c.current_status);

  return {
    overall: productStatuses.length
      ? overallStatus(productStatuses)
      : components.length
        ? overallStatus(components.map((c) => c.current_status))
        : "unknown",
    lastCheckAt,
    stale,
    generatedAt: now,
    components: views,
    incidents,
  };
}

// ---------- rendering ----------

const STATUS_LABEL: Record<string, string> = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Major Outage",
  unknown: "Unknown",
};

const OVERALL_LABEL: Record<OverallStatus, string> = {
  operational: "All Systems Operational",
  degraded: "Degraded Performance",
  outage: "Major Outage",
  unknown: "Unknown",
};

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[c],
  );
}

function fmtUptime(u: number | null): string {
  return u == null ? "—" : `${u.toFixed(2)}%`;
}

function renderSparkline(
  points: { ts: number; latency_ms: number | null }[],
): string {
  const vals = points
    .map((p) => p.latency_ms)
    .filter((v): v is number => v != null);
  if (vals.length < 2) return `<span class="nodata">no latency data yet</span>`;

  const step = Math.max(1, Math.ceil(points.length / 80));
  const sampled = points
    .filter((_, i) => i % step === 0)
    .map((p) => p.latency_ms)
    .filter((v): v is number => v != null);
  if (sampled.length < 2)
    return `<span class="nodata">no latency data yet</span>`;

  const max = Math.max(...sampled, 1);
  const w = 240;
  const h = 36;
  const coords = sampled
    .map((v, i) => {
      const x = (i / (sampled.length - 1)) * w;
      const y = h - (v / max) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${coords}" /></svg>`;
}

function renderBars(bars: { day: string; uptime: number | null }[]): string {
  return bars
    .map((b) => {
      let cls = "bar-none";
      let label = `${b.day}: no data`;
      if (b.uptime != null) {
        cls =
          b.uptime >= 99.5 ? "bar-ok" : b.uptime >= 90 ? "bar-warn" : "bar-down";
        label = `${b.day}: ${b.uptime.toFixed(2)}% uptime`;
      }
      return `<div class="bar ${cls}" title="${label}"></div>`;
    })
    .join("");
}

function renderComponent(c: ComponentView): string {
  const status = c.current_status;
  const label = STATUS_LABEL[status] ?? status;
  return `
    <div class="card">
      <div class="card-head">
        <span class="dot dot-${status}"></span>
        <span class="card-name">${escapeHtml(c.name)}</span>
        <span class="card-status status-${status}">${label}</span>
      </div>
      <div class="bars" title="90-day daily uptime">${renderBars(c.dailyBars)}</div>
      <div class="card-stats">
        <span><b>24h</b> ${fmtUptime(c.uptime24h)}</span>
        <span><b>7d</b> ${fmtUptime(c.uptime7d)}</span>
        <span><b>30d</b> ${fmtUptime(c.uptime30d)}</span>
        <span><b>90d</b> ${fmtUptime(c.uptime90d)}</span>
      </div>
      <div class="sparkline">${renderSparkline(c.sparkline)}</div>
      <div class="card-foot">
        <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.url)}</a>
        <span class="p95">p95(24h): ${c.p95_24h_ms == null ? "—" : `${c.p95_24h_ms}ms`}</span>
      </div>
    </div>`;
}

function renderIncidents(incidents: IncidentRow[], now: number): string {
  if (incidents.length === 0)
    return `<p class="empty">No incidents recorded.</p>`;
  return `<ul class="incidents-list">${incidents
    .map((i) => {
      const resolved = i.resolved_at != null;
      const dur = formatDuration(i.started_at, i.resolved_at, now);
      const start = new Date(i.started_at).toISOString().slice(0, 16).replace("T", " ");
      const sev = i.severity === "major" ? "sev-major" : "sev-degraded";
      const state = resolved
        ? `resolved after ${dur}`
        : `ongoing · ${dur}`;
      return `<li class="${sev}">
        <span class="inc-sev">${i.severity}</span>
        <span class="inc-title">${escapeHtml(i.title ?? i.target)}</span>
        <span class="inc-time">${start}Z · ${state}</span>
      </li>`;
    })
    .join("")}</ul>`;
}

function renderHtml(model: StatusModel, now: number): string {
  const banner = model.stale
    ? `<div class="banner">⚠ Monitoring system may be degraded — last check ${formatAgo(model.lastCheckAt, now)}.</div>`
    : "";
  const cards = model.components
    .map(renderComponent)
    .join("\n");
  const overallCls = model.overall;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Talus Ship Status</title>
  <style>
    :root {
      --ok:#16a34a; --warn:#d97706; --down:#dc2626; --unknown:#6b7280;
      --bg:#0b1020; --panel:#141a2e; --panel2:#1b2238; --text:#e5e7eb; --muted:#9aa3b2;
      --border:#262d44;
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text);
      font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
    .wrap { max-width:880px; margin:0 auto; padding:32px 20px 64px; }
    header { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
    h1 { font-size:22px; margin:0; font-weight:650; }
    .badge { padding:4px 12px; border-radius:999px; font-size:13px; font-weight:600; }
    .badge-operational { background:rgba(22,163,74,.15); color:#4ade80; }
    .badge-degraded { background:rgba(217,119,6,.15); color:#fbbf24; }
    .badge-outage { background:rgba(220,38,38,.15); color:#f87171; }
    .badge-unknown { background:rgba(107,114,128,.15); color:#9ca3af; }
    .banner { margin-top:16px; padding:10px 14px; border-radius:8px;
      background:rgba(220,38,38,.12); color:#fca5a5; border:1px solid rgba(220,38,38,.3); }
    .meta { color:var(--muted); font-size:13px; margin:14px 0 22px; }
    .card { background:var(--panel); border:1px solid var(--border); border-radius:12px;
      padding:16px 18px; margin-bottom:14px; }
    .card-head { display:flex; align-items:center; gap:10px; }
    .card-name { font-weight:600; }
    .card-status { margin-left:auto; font-size:13px; font-weight:600; }
    .status-operational { color:#4ade80; } .status-degraded { color:#fbbf24; }
    .status-outage { color:#f87171; } .status-unknown { color:#9ca3af; }
    .dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
    .dot-operational { background:var(--ok); } .dot-degraded { background:var(--warn); }
    .dot-outage { background:var(--down); } .dot-unknown { background:var(--unknown); }
    .bars { display:flex; gap:2px; height:34px; margin:14px 0 10px; align-items:flex-end; }
    .bar { flex:1; min-width:2px; border-radius:2px 2px 0 0; height:100%; }
    .bar-ok { background:var(--ok); } .bar-warn { background:var(--warn); }
    .bar-down { background:var(--down); } .bar-none { background:var(--panel2); }
    .card-stats { display:flex; gap:18px; color:var(--muted); font-size:13px; }
    .card-stats b { color:var(--text); font-weight:600; margin-right:4px; }
    .sparkline { margin-top:12px; }
    .spark { width:100%; height:36px; display:block; }
    .spark polyline { fill:none; stroke:#60a5fa; stroke-width:1.5; }
    .nodata { color:var(--muted); font-size:12px; }
    .card-foot { display:flex; justify-content:space-between; align-items:center;
      margin-top:10px; font-size:12px; color:var(--muted); gap:10px; flex-wrap:wrap; }
    .card-foot a { color:#93c5fd; text-decoration:none; }
    .p95 { white-space:nowrap; }
    h2 { font-size:16px; margin:28px 0 12px; }
    .incidents-list { list-style:none; padding:0; margin:0; }
    .incidents-list li { background:var(--panel); border:1px solid var(--border);
      border-radius:8px; padding:10px 14px; margin-bottom:8px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .inc-sev { font-size:11px; font-weight:700; text-transform:uppercase; padding:2px 8px; border-radius:4px; }
    .sev-degraded .inc-sev { background:rgba(217,119,6,.2); color:#fbbf24; }
    .sev-major .inc-sev { background:rgba(220,38,38,.2); color:#f87171; }
    .inc-title { font-weight:600; }
    .inc-time { color:var(--muted); font-size:12px; margin-left:auto; }
    .empty { color:var(--muted); }
    footer { margin-top:40px; color:var(--muted); font-size:12px; }
    footer a { color:#93c5fd; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Talus Ship Status</h1>
      <span class="badge badge-${overallCls}">${OVERALL_LABEL[model.overall]}</span>
    </header>
    ${banner}
    <p class="meta">Last checked ${formatAgo(model.lastCheckAt, now)} · Checks run every minute from Cloudflare's edge (single region).</p>
    <main>
      ${cards}
      <h2>Recent incidents</h2>
      ${renderIncidents(model.incidents, now)}
    </main>
    <footer>
      Checks run every minute from Cloudflare's edge. · <a href="/api/status">/api/status</a> JSON.
    </footer>
  </div>
</body>
</html>`;
}

export async function renderPage(db: D1Database, now: number): Promise<Response> {
  const model = await buildStatusModel(db, now);
  return new Response(renderHtml(model, now), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function statusJson(db: D1Database, now: number): Promise<Response> {
  const model = await buildStatusModel(db, now);
  const body = {
    overall: model.overall,
    lastCheckAt: model.lastCheckAt,
    stale: model.stale,
    generatedAt: model.generatedAt,
    components: model.components.map((c) => ({
      slug: c.slug,
      name: c.name,
      url: c.url,
      status: c.current_status,
      uptime: {
        "24h": c.uptime24h,
        "7d": c.uptime7d,
        "30d": c.uptime30d,
        "90d": c.uptime90d,
      },
      p95_24h_ms: c.p95_24h_ms,
    })),
    incidents: model.incidents,
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
