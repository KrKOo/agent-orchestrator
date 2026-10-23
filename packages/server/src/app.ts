import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { Hono } from "hono";
import { flowRoutes } from "./api/flows";
import { runnerRoutes } from "./api/runners";
import { runRoutes } from "./api/runs";
import type { ServerConfig } from "./config";
import { createDb, type Db } from "./db";
import type { AppDeps } from "./deps";
import { GitHubApi } from "./github/api";
import { credentialsFromConfig, type GitHubCredentials } from "./github/credentials";
import { Hub } from "./hub";
import { RunService } from "./runs";
import { Scheduler } from "./scheduler";
import { registerBrowserWs } from "./ws/browser";
import { registerRunnerWs } from "./ws/runner";

export const DEFAULT_WEB_DIST = join(import.meta.dir, "../../web/dist");

export interface DepsOptions {
  db?: Db;
  credentials?: GitHubCredentials;
  github?: GitHubApi;
  webDist?: string;
}

/** Wires the default dependency graph; tests override pieces (e.g. an in-memory DB, a fake GitHub). */
export function createDeps(config: ServerConfig, opts: DepsOptions = {}): AppDeps {
  const db = opts.db ?? createDb(join(config.dataDir, "orch.sqlite"));
  const hub = new Hub();
  const runs = new RunService(db, hub);
  return {
    config,
    db,
    hub,
    runs,
    scheduler: new Scheduler(runs),
    credentials: opts.credentials ?? credentialsFromConfig(config.github),
    github: opts.github ?? new GitHubApi(),
    webDist: opts.webDist ?? DEFAULT_WEB_DIST,
  };
}

function serveWeb(webDist: string, path: string): Response {
  const index = join(webDist, "index.html");
  if (!existsSync(index)) {
    return new Response("Web UI not built. Run `bun run --filter @orch/web build`, or use the Vite dev server.\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  let rel: string;
  try {
    rel = decodeURIComponent(path);
  } catch {
    rel = "/";
  }
  const file = normalize(join(webDist, rel));
  if (file.startsWith(webDist + sep) && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
  return new Response(Bun.file(index), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    console.error(`[http] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
  });

  // WebSocket routes are registered before the REST sub-apps so `/api/runs/:id/stream` is not shadowed.
  registerBrowserWs(app, deps);
  registerRunnerWs(app, deps);

  const runs = runRoutes(deps);
  const runners = runnerRoutes(deps);
  app.route("/api/flows", flowRoutes(deps));
  app.route("/api/flows", runs.flowRuns);
  app.route("/api/runs", runs.runs);
  app.route("/api/runners", runners.runners);
  app.route("/api/catalog", runners.catalog);
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  app.all("/runner/*", (c) => c.json({ error: "Not found" }, 404));

  app.get("*", (c) => serveWeb(deps.webDist, c.req.path));

  return app;
}
