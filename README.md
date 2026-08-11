# talus-watchdog

Synthetic monitoring + public status page for the **Talus Ship** product
(a Cloudflare Worker at `app.taluship.com`), served at
**https://status.taluship.com**.

v1 scope: **synthetic checks + status page**. No account API access required.

- One Worker (`talus-watchdog`) with two handlers:
  - **`scheduled` (cron, every 1 min)** — runs a health check against each target,
    writes results to **D1**, updates component status + incident state.
  - **`fetch` (HTTP)** — serves the status page HTML (and `/api/status` JSON) at
    `status.taluship.com`, reading aggregates from D1. Cached ~30s.
- Storage: **D1** (`watchdog-db`) — checks, incidents, components, daily rollups.

See [`PLAN.md`](./PLAN.md) for the full design, monitoring principles, and the
v2 backlog (alerting, multi-region, GraphQL analytics enrichment).

---

## Targets (v1)

| Slug | URL | Why |
|------|-----|-----|
| `app` | `https://app.taluship.com` | The product Worker — **primary**. |
| `apex` | `https://taluship.com` | Apex — secondary. |
| `cloudflare` | `https://cloudflare.com` | Always-up control, to distinguish "target down" from a checker-side blip. |

Edit `src/config.ts` to change targets or add an `expectedContent` substring
(v1.5 content check: a 200 that omits the string reads as "up but broken").

## Incident thresholds

| Consecutive failures | Component status | Action |
|----------------------|------------------|--------|
| 1 | unchanged | log check only |
| 2 | Degraded | open incident |
| 5 (~5 min) | Major Outage | escalate incident |
| 2 consecutive successes | Operational | resolve incident |

A single failed check is noise, not an incident — thresholds avoid flapping.

---

## Project layout

```
src/
  index.ts      # wired scheduled + fetch handlers, Cache API, cron compaction
  checker.ts    # runCheck (fetchWithTimeout) + applyCheck (pure incident logic)
  db.ts         # D1 queries (checks/incidents/components)
  page.ts       # HTML + /api/status JSON, pure uptime/percentile/format helpers
  config.ts     # targets, thresholds, timeouts, retention
migrations/
  0001_init.sql # D1 schema
test/
  checker.test.ts  # unit tests for applyCheck + page helpers
```

## Develop

```sh
npm install

# 1. create the D1 database (remote — needs `wrangler login`)
npm run db:create
#    -> paste the printed database_id into wrangler.toml

# 2. apply the schema locally and run dev
npm run migrate:local
npm run dev          # http://localhost:8787

# type-check + unit tests
npm run typecheck
npm run test
```

> `wrangler dev` uses a **local** D1 (SQLite under `.wrangler/`), so the page
> works without a remote DB once you've run `migrate:local`. The cron handler
> can be triggered from the wrangler dev dashboard (`⌚ scheduled`).

## Deploy

```sh
# apply schema to the remote DB
npm run migrate:remote

# deploy the Worker
npm run deploy
```

### Custom domain (status.taluship.com)

Uncomment the `routes` block in `wrangler.toml`, then `npm run deploy`. A
Workers **Custom Domain** auto-creates the proxied DNS record in the
`taluship.com` zone — no manual DNS editing. Verify it loads at
`https://status.taluship.com`.

## Validate (Phase 5)

- Confirm the cron is firing: `checks` rows grow each minute and
  `components.last_check_at` is current (`SELECT * FROM components`).
- **Incident drill:** temporarily add a dead target (e.g.
  `https://example.invalid`) to `src/config.ts`, redeploy, and confirm
  Degraded → Outage transition, an `incidents` row, and auto-recovery on revert.
- After ~24h of data, confirm the uptime bars + latency sparkline render.

Inspect the DB:

```sh
npx wrangler d1 execute watchdog-db --remote --command "SELECT slug, current_status, consecutive_failures, last_check_at FROM components"
npx wrangler d1 execute watchdog-db --remote --command "SELECT target, ts, status, ok, latency_ms, error FROM checks ORDER BY ts DESC LIMIT 20"
npx wrangler d1 execute watchdog-db --remote --command "SELECT * FROM incidents ORDER BY started_at DESC LIMIT 10"
```

## Self-monitoring

Every cron tick stamps `components.last_check_at`, even on partial failure. The
status page shows a banner if the newest check is older than ~5 min — a status
page that silently stops updating is worse than no status page.

## Caveats (v1)

- The checker runs **inside** Cloudflare, so a Cloudflare platform incident
  could take down both the product and the watchdog. v2 mitigations (an
  external checker, highly-cacheable page) are in the backlog.
- `colo` is left `NULL`: it isn't exposed to `scheduled` events.
- 90-day uptime is computed **live** from `checks` (raw data is retained 90
  days, pruned hourly). `daily_aggregates` exists for future >90-day history.
- `[verify in docs]` items in `PLAN.md` (cron limits, D1 quotas, custom-domain
  auto-DNS) should be confirmed against https://developers.cloudflare.com/
  before finalizing.
