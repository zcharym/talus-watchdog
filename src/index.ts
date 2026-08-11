// talus-watchdog entry point.
//   scheduled (cron, every 1 min) -> run synthetic checks, write D1, update state
//   fetch (HTTP)                  -> serve the status page / /api/status JSON

import {
  TARGETS,
  RETENTION_DAYS,
  PAGE_CACHE_TTL_S,
} from "./config";
import {
  runCheck,
  applyCheck,
  type IncidentAction,
  type StatusUpdate,
} from "./checker";
import {
  ensureComponentsSeeded,
  getComponent,
  recordCheck,
  updateComponent,
  stampLastCheckAt,
  openIncident,
  escalateIncident,
  resolveOpenIncident,
  pruneOldChecks,
  type ComponentRow,
} from "./db";
import { renderPage, statusJson } from "./page";

export interface Env {
  DB: D1Database;
}

export default {
  async scheduled(
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runChecks(env, event.scheduledTime));
  },

  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handleFetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

function defaultComponentRow(slug: string, name: string, url: string): ComponentRow {
  return {
    slug,
    name,
    url,
    current_status: "operational",
    consecutive_failures: 0,
    consecutive_successes: 0,
    last_check_at: null,
  };
}

async function applyIncidentAction(
  db: D1Database,
  slug: string,
  action: IncidentAction,
  now: number,
): Promise<void> {
  switch (action.type) {
    case "none":
      return;
    case "open":
      await openIncident(db, slug, action.severity, action.title, now);
      return;
    case "escalate":
      await escalateIncident(db, slug, action.severity, action.title, now);
      return;
    case "resolve":
      await resolveOpenIncident(db, slug, now);
      return;
  }
}

/**
 * Run a check against every configured target and persist results.
 * Each target is isolated: a failure (network or DB) for one target never
 * stops the others, and last_check_at is always stamped (self-monitor).
 */
async function runChecks(env: Env, scheduledTime: number): Promise<void> {
  const now = Date.now();
  const db = env.DB;

  try {
    await ensureComponentsSeeded(db);
  } catch (e) {
    console.error("ensureComponentsSeeded failed", e);
  }

  for (const target of TARGETS) {
    let update: StatusUpdate | null = null;
    try {
      const check = await runCheck(target);
      const state =
        (await getComponent(db, target.slug)) ??
        defaultComponentRow(target.slug, target.name, target.url);
      update = applyCheck(state, check, now);
      await applyIncidentAction(db, target.slug, update.incidentAction, now);
      await recordCheck(db, check, now);
    } catch (e) {
      console.error(`check processing failed for ${target.slug}`, e);
    }

    // Self-monitor: always attempt to stamp last_check_at, even on partial failure.
    try {
      if (update) {
        await updateComponent(db, target.slug, update);
      } else {
        await stampLastCheckAt(db, target.slug, now);
      }
    } catch (e) {
      console.error(`stamp last_check_at failed for ${target.slug}`, e);
    }
  }

  // Compaction: prune raw checks older than RETENTION_DAYS, ~hourly.
  try {
    if (new Date(scheduledTime).getUTCMinutes() === 0) {
      await pruneOldChecks(db, now - RETENTION_DAYS * 86_400_000);
    }
  } catch (e) {
    console.error("compaction failed", e);
  }
}

async function handleFetch(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const now = Date.now();

  const cache = caches.default;
  const cached = await cache.match(req);
  if (cached) return cached;

  let response: Response;
  if (url.pathname === "/") {
    response = await renderPage(env.DB, now);
  } else if (url.pathname === "/api/status") {
    response = await statusJson(env.DB, now);
  } else if (url.pathname === "/favicon.ico") {
    response = new Response(null, { status: 204 });
  } else {
    response = new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Cache successful responses for ~30s to keep page loads fast and cut D1 reads.
  if (response.status === 200) {
    response = new Response(response.body, response);
    response.headers.set(
      "Cache-Control",
      `public, s-maxage=${PAGE_CACHE_TTL_S}`,
    );
    ctx.waitUntil(cache.put(req, response.clone()));
  }
  return response;
}
