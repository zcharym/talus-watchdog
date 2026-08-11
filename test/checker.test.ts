import { describe, it, expect } from "vitest";
import {
  applyCheck,
  type CheckResult,
  type ComponentState,
} from "../src/checker";
import { TARGETS, THRESHOLDS } from "../src/config";
import {
  overallStatus,
  uptimePct,
  uptimeFromBuckets,
  p95Latency,
  formatAgo,
  formatDuration,
  lastNDays,
} from "../src/page";
import type { DailyBucket } from "../src/db";

const target = TARGETS[0];
const NOW = 1_700_000_000_000;

const okCheck = (): CheckResult => ({
  target,
  status: 200,
  latencyMs: 50,
  ok: true,
  error: null,
});
const failCheck = (status = 500): CheckResult => ({
  target,
  status,
  latencyMs: 50,
  ok: false,
  error: `http ${status}`,
});
const check4xx = (): CheckResult => ({
  target,
  status: 404,
  latencyMs: 50,
  ok: true, // 4xx is not a crash -> treated as success for incident logic
  error: null,
});
const state = (
  current_status = "operational",
  consecutive_failures = 0,
  consecutive_successes = 0,
): ComponentState => ({ current_status, consecutive_failures, consecutive_successes });

describe("applyCheck - thresholds & incident transitions", () => {
  it("1 failure from operational: status unchanged, no incident", () => {
    const u = applyCheck(state("operational"), failCheck(), NOW);
    expect(u.current_status).toBe("operational");
    expect(u.consecutive_failures).toBe(1);
    expect(u.incidentAction).toEqual({ type: "none" });
  });

  it("2 consecutive failures: Degraded + open degraded incident", () => {
    const u = applyCheck(state("operational", THRESHOLDS.degraded - 1), failCheck(), NOW);
    expect(u.current_status).toBe("degraded");
    expect(u.incidentAction).toEqual({
      type: "open",
      severity: "degraded",
      title: `${target.name} degraded`,
    });
  });

  it("5 consecutive failures from degraded: Major Outage + escalate", () => {
    const u = applyCheck(
      state("degraded", THRESHOLDS.outage - 1),
      failCheck(),
      NOW,
    );
    expect(u.current_status).toBe("outage");
    expect(u.incidentAction).toEqual({
      type: "escalate",
      severity: "major",
      title: `${target.name} major outage`,
    });
  });

  it("reaching outage threshold from operational: opens major directly (defensive)", () => {
    const u = applyCheck(
      state("operational", THRESHOLDS.outage - 1),
      failCheck(),
      NOW,
    );
    expect(u.current_status).toBe("outage");
    expect(u.incidentAction.type).toBe("open");
    expect(u.incidentAction).toMatchObject({ severity: "major" });
  });

  it("2 consecutive successes after outage: Operational + resolve", () => {
    const u = applyCheck(
      state("outage", 0, THRESHOLDS.recovery - 1),
      okCheck(),
      NOW,
    );
    expect(u.current_status).toBe("operational");
    expect(u.incidentAction).toEqual({ type: "resolve" });
  });

  it("1 success after outage: still outage, no resolve (hysteresis)", () => {
    const u = applyCheck(state("outage", 0, 0), okCheck(), NOW);
    expect(u.current_status).toBe("outage");
    expect(u.consecutive_successes).toBe(1);
    expect(u.incidentAction.type).toBe("none");
  });

  it("success resets consecutive_failures", () => {
    const u = applyCheck(state("degraded", 3, 0), okCheck(), NOW);
    expect(u.consecutive_failures).toBe(0);
    expect(u.consecutive_successes).toBe(1);
    expect(u.current_status).toBe("degraded"); // not yet 2 successes
  });

  it("failure resets consecutive_successes", () => {
    const u = applyCheck(state("operational", 0, 3), failCheck(), NOW);
    expect(u.consecutive_successes).toBe(0);
    expect(u.consecutive_failures).toBe(1);
  });

  it("continued failure while already outage: no duplicate incident", () => {
    const u = applyCheck(state("outage", 5, 0), failCheck(), NOW);
    expect(u.current_status).toBe("outage");
    expect(u.incidentAction.type).toBe("none");
  });

  it("4xx is treated as a success (not a crash)", () => {
    const u = applyCheck(state("operational", 0, 0), check4xx(), NOW);
    expect(u.consecutive_successes).toBe(1);
    expect(u.consecutive_failures).toBe(0);
    expect(u.current_status).toBe("operational");
  });

  it("always stamps last_check_at", () => {
    const u = applyCheck(state("operational"), okCheck(), NOW);
    expect(u.last_check_at).toBe(NOW);
  });
});

describe("page - pure helpers", () => {
  it("overallStatus picks the worst", () => {
    expect(overallStatus(["operational", "operational"])).toBe("operational");
    expect(overallStatus(["operational", "degraded"])).toBe("degraded");
    expect(overallStatus(["degraded", "outage"])).toBe("outage");
    expect(overallStatus(["operational", "unknown"])).toBe("unknown");
    expect(overallStatus([])).toBe("operational");
  });

  it("uptimePct returns null when there is no data", () => {
    expect(uptimePct(99, 100)).toBe(99);
    expect(uptimePct(0, 0)).toBeNull();
    expect(uptimePct(1, 3)).toBeCloseTo(33.3333, 4);
  });

  it("uptimeFromBuckets sums only days within the window", () => {
    const buckets: DailyBucket[] = [
      { day: "2026-08-04", ok_count: 1440, total: 1440 },
      { day: "2026-08-05", ok_count: 720, total: 1440 },
      { day: "2026-08-06", ok_count: 100, total: 100 },
    ];
    const now = Date.UTC(2026, 7, 6, 12, 0); // 2026-08-06 12:00 UTC
    const u = uptimeFromBuckets(buckets, now - 7 * 86_400_000);
    // all three days fall within the last 7 days
    expect(u).toBeCloseTo(((1440 + 720 + 100) / (1440 + 1440 + 100)) * 100, 5);
  });

  it("p95Latency computes the 95th percentile", () => {
    expect(p95Latency([])).toBeNull();
    expect(p95Latency([100])).toBe(100);
    const arr = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(p95Latency(arr)).toBe(95);
  });

  it("formatAgo formats human-friendly relative time", () => {
    const now = 1_000_000;
    expect(formatAgo(null, now)).toBe("never");
    expect(formatAgo(now, now)).toBe("0s ago");
    expect(formatAgo(now - 30_000, now)).toBe("30s ago");
    expect(formatAgo(now - 120_000, now)).toBe("2m ago");
    expect(formatAgo(now - 7_200_000, now)).toBe("2h ago");
  });

  it("formatDuration handles resolved and ongoing", () => {
    const now = 1_000_000;
    expect(formatDuration(now - 120_000, now, now)).toBe("2m");
    expect(formatDuration(now - 120_000, null, now)).toBe("2m"); // ongoing uses now
    expect(formatDuration(now - 3_600_000, null, now)).toBe("1h 0m");
  });

  it("lastNDays returns day strings oldest-first ending today", () => {
    const now = Date.UTC(2026, 7, 6, 0, 0); // 2026-08-06 UTC
    expect(lastNDays(3, now)).toEqual([
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
    ]);
  });
});
