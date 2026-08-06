# talus-watchdog — Status Page & Monitoring Plan

> Monitoring + public status page for the Talus Ship product (a Cloudflare Worker at
> `app.taluship.com`), served at **https://status.taluship.com**.
> v1 scope: **synthetic checks + status page** (no account API access required).

---

## Starting point (verified from this environment)

| Item | State |
|------|-------|
| Repo `talus-watchdog` | Empty — not git-initialized. Clean slate. |
| `taluship.com` nameservers | Cloudflare (`betty`/`hasslo.ns.cloudflare.com`). Email Routing present (SPF). |
| `app.taluship.com` | Resolves to Cloudflare-proxied IPs (`104.21.86.177`, `172.67.223.76`) → **served by a Cloudflare Worker**. |
| `taluship.com` (apex) | Resolves (Cloudflare-proxied). |
| `status.taluship.com` | **NXDOMAIN — does not exist yet.** Needs a DNS record + a Worker to serve it. |
| Cloudflare API access in this env | None (no token, no `wrangler` auth). v1 design avoids needing it. |

> ⚠️ Retrieval (WebFetch / WebSearch) was unavailable in this environment, so specific
> Cloudflare limits/config below are marked **[verify in docs]**. Confirm them at
> https://developers.cloudflare.com/ before finalizing. Where docs and this plan
> disagree, trust the docs.

---

## Architecture (v1)

**One Worker** (`talus-watchdog`) with two handlers:

- **`scheduled` (cron, every 1 min)** — runs synthetic health checks against each target,
  writes results to **D1**, updates each component's current status + incident state.
- **`fetch` (HTTP)** — serves the public status page HTML at `status.taluship.com`,
  reading aggregates from D1. Response cached for ~30s.

**Storage:**
- **D1 (`watchdog-db`)** — source of truth: raw checks, incidents, components, daily rollups.
- **KV (`STATUS_CACHE`, optional in v1)** — cache the rendered page / current-status snapshot
  (TTL ~30s) to keep page loads fast and cut D1 reads. Skip in v1; add if read volume or
  D1 read cost becomes a concern.

**DNS / domain:** Workers **Custom Domain** on `status.taluship.com` → auto-creates the
proxied DNS record in the `taluship.com` zone **[verify in docs]**. No manual DNS editing.

---

## Monitoring insights — *how to monitor, and why*

This is the core of the plan. The principles drive the design.

### 1. Checking from the edge is cheap and simple — but know the tradeoff
The checker is itself a Cloudflare Worker, so it lives *inside* Cloudflare. If Cloudflare
has a platform incident, **both the product Worker and the watchdog may fail together** —
the status page could be down exactly when users need it.

- **v1 accepts this.** It still catches the common cases: app bugs, bad deploys, broken
  config, expired secrets, route changes. And it's free.
- **v2 mitigations (backlog):** add one *external* checker (UptimeRobot/Checkly free tier)
  hitting the same endpoints, and/or expose `/api/status` JSON so an outside monitor can
  validate the watchdog. Make the status page highly cacheable so it survives traffic spikes
  even when the Worker is slow.

### 2. A single failed check is noise, not an incident
Define incident logic with **consecutive-failure thresholds** to avoid flapping:

| Consecutive failures | Component status | Action |
|----------------------|------------------|--------|
| 1 | (unchanged) | Log the check only |
| 2 | **Degraded** | Flag component |
| 5 (≈5 min) | **Major Outage** | Open an incident |
| 2 consecutive successes | **Operational** | Resolve incident |

Store the consecutive-failure counter in D1 (or KV) between cron runs.

### 3. "Down" for a Worker has several meanings — check each
| Signal | Interpretation | Status |
|--------|----------------|--------|
| `fetch()` throws (network/DNS/TLS) | Unreachable | Down |
| HTTP status ≥ 500 | Server error | Down |
| HTTP 4xx unexpectedly | Likely route/config change, not a crash | Investigate (don't auto-mark down) |
| Timeout (> 8–10s via `AbortController`) | Slow/unresponsive | Degraded/Down |
| HTTP 200 but content check fails | "Up but broken" | Degraded |
| TLS cert expiring soon | Warning before it bites | Warning |

**v1.5 (recommended quick win):** assert the response contains an expected string, or have
the product Worker expose a `/health` endpoint and check that — a 200 returning an error
page shouldn't read as "up."

### 4. Measure latency, not just up/down
Record **TTFB and total response time**. A `200` that takes 12s is a degraded experience.
Show a latency sparkline on the page; in v2, alert on latency above an SLO threshold even
when status is 2xx.

### 5. Retention strategy matters for D1
At 1 check/min × 2 targets ≈ **2,880 rows/day ≈ 1M rows/year**. Plan:
- Keep **raw checks for 30–90 days**, then roll up to **hourly/daily buckets**
  (uptime %, p95 latency, incident count) for the 90-day and long-historical views.
- A weekly compaction step (extra cron or a branch in the 1-min cron) archives old rows.
- **[verify in docs]** D1 max DB size and rows-read/written-per-day on free vs paid — these
  drive the exact retention window.

### 6. Self-monitor the watchdog
Store `last_check_at` on **every** cron run (even on partial failure). The status page
checks it: if the newest check is older than ~5 min, show a banner:
**"Monitoring system may be degraded — last check X min ago."**
A status page that silently stops updating is worse than no status page.

### 7. Be honest on the page about what's measured
"Checks run every minute from Cloudflare's edge (single region)." Don't imply global
multi-region coverage in v1 — that's a v2 enhancement.

---

## What to monitor (v1 target list)

| Target | Why |
|--------|-----|
| `https://app.taluship.com` | The product Worker — **primary**. |
| `https://taluship.com` | Apex — secondary (confirm it's the same Worker or a redirect). |
| `https://cloudflare.com` (control) | Always-up external baseline to distinguish "target down" from "checker's network blip." **Recommended.** |

---

## Data model (D1)

```sql
-- raw health checks
CREATE TABLE checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target      TEXT NOT NULL,
  ts          INTEGER NOT NULL,        -- epoch ms
  status      INTEGER,                 -- HTTP status, or NULL on throw
  latency_ms  INTEGER,
  ok          INTEGER NOT NULL,        -- 1/0
  error       TEXT,                    -- reason string on failure
  colo        TEXT                     -- request.cf.colo of the checker
);
CREATE INDEX idx_checks_target_ts ON checks(target, ts);

-- incidents (one per degraded/outage window per target)
CREATE TABLE incidents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  resolved_at  INTEGER,                -- NULL while open
  severity     TEXT NOT NULL,          -- 'degraded' | 'major'
  title        TEXT
);

-- per-component rolling state (read + written each cron tick)
CREATE TABLE components (
  slug                 TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  url                  TEXT NOT NULL,
  current_status       TEXT NOT NULL,  -- 'operational' | 'degraded' | 'outage' | 'unknown'
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_check_at        INTEGER
);

-- daily rollups for 90-day + historical views
CREATE TABLE daily_aggregates (
  day              TEXT NOT NULL,      -- 'YYYY-MM-DD'
  target           TEXT NOT NULL,
  uptime_pct       REAL NOT NULL,
  p95_latency_ms   INTEGER,
  incident_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, target)
);
```

---

## Page layout (status.taluship.com)

- **Header:** "Talus Ship Status" + overall badge (All Operational / Degraded / Outage).
- **Overall row:** "last checked X ago" + **self-monitor banner** if stale.
- **Per-component cards:** current status · 90-day uptime bar · 24h latency sparkline ·
  uptime % (24h / 7d / 30d / 90d).
- **Recent incidents** (last 10) with start/resolved times.
- **Footer:** "Checks run every minute from Cloudflare's edge." + link to `/api/status` JSON.
- **Caching:** Cache API keyed by URL, TTL ~30s; `Cache-Control: public, s-maxage=30`.
- Server-rendered HTML via template literals (no framework) to keep the Worker small and fast.

---

## Phased plan

### Phase 0 — Decisions (confirm before building)
- [ ] Confirm targets (`app.taluship.com` + apex) and whether the product Worker can expose a
      `/health` endpoint for content checks (preferred over scraping HTML).
- [ ] Confirm check interval (recommend **1 min**) and thresholds (2 = degraded, 5 = outage).
- [ ] **[verify in docs]:** cron min interval & max crons/Worker; D1 storage + rows-read/day
      limits; Workers Custom Domain auto-DNS; `fetch` + `AbortController` timeout; scheduled
      handler CPU/subrequest limits.

### Phase 1 — Scaffold
- `git init`, `.gitignore`, `package.json` (wrangler, `@cloudflare/workers-types`, typescript, vitest).
- `wrangler.toml`: `name = "talus-watchdog"`, `main`, `compatibility_date`, plus
  `[triggers] crons = ["* * * * *"]`, D1 binding `DB`, optional KV `STATUS_CACHE`.
- `tsconfig.json`; `src/index.ts` with stub `scheduled` + `fetch` handlers.
- D1: `wrangler d1 create watchdog-db`; migration `0001_init.sql` (schema above);
  `wrangler d1 migrations apply`.

### Phase 2 — Checker (cron path) — `src/checker.ts`
- For each target: `fetchWithTimeout(url, 8000)` via `AbortController`; capture status,
  latency, ok, error, `request.cf.colo`.
- Incident logic: read `components.consecutive_failures`, apply thresholds, open/resolve
  incidents in the `incidents` table.
- Write `checks` row; update `components` (`current_status`, `consecutive_failures`, `last_check_at`).
- Wrap all DB writes in try/catch so a DB hiccup doesn't kill the cron. Always stamp
  `last_check_at` (self-monitor).

### Phase 3 — Status page (fetch path) — `src/page.ts`
- Query aggregates (90-day daily, 24h recent checks for sparkline, open incidents);
  render server-side HTML.
- Routes: `GET /` → HTML (cached) · `GET /api/status` → JSON (for future external monitors /
  v2 alerting) · `GET /favicon.ico` → 204.
- Cache via Cache API, TTL 30s.

### Phase 4 — Custom domain
- Add `status.taluship.com` as a Workers Custom Domain in `wrangler.toml`
  (auto-creates the proxied DNS record in the zone).
- `wrangler deploy`; verify `https://status.taluship.com` loads.

### Phase 5 — Validate
- Confirm cron is firing (D1 rows growing each minute; `components.last_check_at` current).
- **Incident drill:** temporarily add a dead target (e.g. `https://example.invalid`) → confirm
  Degraded → Outage transition, incident row, and auto-recovery.
- Confirm uptime bars + latency sparkline render after 24h of data.

### Phase 6 — Out of v1 (backlog, per your scope choice)
- **Cloudflare GraphQL Analytics enrichment** (needs a read-only API token): pull 5xx rate,
  request volume, Worker CPU/errors → show on page + use as a second incident signal.
- **Alerting:** email (Cloudflare Email Routing) + webhook (Slack/Discord) on incident open/resolve.
- **Multi-region checks** (fan out via Service Bindings) for true global coverage.
- **Manual incident notes / scheduled maintenance** via a secret-protected `POST /admin`.

---

## Verify-before-deploy checklist (retrieval was blocked here)
- [ ] Cron: minimum interval (expect 1 min) and max cron triggers per Worker.
- [ ] D1: max DB size, rows read/written per day on free vs paid → drives retention window.
- [ ] Workers Custom Domain: confirms it auto-creates the proxied DNS record in the existing zone.
- [ ] Scheduled handler: CPU time limit; confirm `fetch` subrequest limits apply.
- [ ] `fetch()` + `AbortController` timeout support and any default timeout.
