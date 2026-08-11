-- Add ok_count/total so weighted multi-day uptime % can be computed from
-- daily_aggregates without rescanning raw checks.

ALTER TABLE daily_aggregates ADD COLUMN ok_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_aggregates ADD COLUMN total INTEGER NOT NULL DEFAULT 0;
