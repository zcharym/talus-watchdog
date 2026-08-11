-- talus-watchdog v1 schema
-- Docs: see PLAN.md "Data model (D1)".
-- Deviation from plan: components also tracks consecutive_successes so the
-- "2 consecutive successes -> Operational" recovery rule can be evaluated
-- (the plan's schema listed only consecutive_failures).

-- raw health checks (1 row per target per cron tick)
CREATE TABLE checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target      TEXT NOT NULL,            -- component slug
  ts          INTEGER NOT NULL,         -- epoch ms
  status      INTEGER,                  -- HTTP status, or NULL on throw/timeout
  latency_ms  INTEGER,                  -- total response time (ms)
  ok          INTEGER NOT NULL,         -- 1 = healthy, 0 = failure
  error       TEXT,                     -- reason string on failure
  colo        TEXT                      -- request.cf.colo of the checker (NULL in cron)
);
CREATE INDEX idx_checks_target_ts ON checks(target, ts);
CREATE INDEX idx_checks_ts ON checks(ts);

-- incidents: one per degraded/outage window per target
CREATE TABLE incidents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  resolved_at  INTEGER,                 -- NULL while open
  severity     TEXT NOT NULL,           -- 'degraded' | 'major'
  title        TEXT
);
CREATE INDEX idx_incidents_target_open ON incidents(target, resolved_at);
CREATE INDEX idx_incidents_started ON incidents(started_at);

-- per-component rolling state (read + written each cron tick)
CREATE TABLE components (
  slug                 TEXT PRIMARY KEY,           -- matches config TARGETS[].slug
  name                 TEXT NOT NULL,
  url                  TEXT NOT NULL,
  current_status       TEXT NOT NULL DEFAULT 'operational',  -- 'operational' | 'degraded' | 'outage' | 'unknown'
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_check_at        INTEGER                     -- epoch ms; NULL until first check
);

-- daily rollups for >90-day historical views (populated by a future compaction step;
-- v1 computes the 90-day view live from `checks` since raw data is retained 90 days).
CREATE TABLE daily_aggregates (
  day              TEXT NOT NULL,      -- 'YYYY-MM-DD' (UTC)
  target           TEXT NOT NULL,
  uptime_pct       REAL NOT NULL,
  p95_latency_ms   INTEGER,
  incident_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, target)
);
