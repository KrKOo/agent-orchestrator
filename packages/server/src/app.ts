import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { MeResponse } from "@orch/protocol";
import { Webhooks } from "@octokit/webhooks";
import { Hono } from "hono";
import { flowRoutes } from "./api/flows";
import { runnerRoutes } from "./api/runners";
import { runRoutes } from "./api/runs";
import { oauthRoutes } from "./auth/github-oauth";
import { requireSession, sessionUser } from "./auth/session";
import { DEFAULT_MAX_CONCURRENT_PER_REPO, type ServerConfig } from "./config";
import { createDb, type Db } from "./db";
import type { AppDeps } from "./deps";
import { GitHubApi } from "./github/api";
import { CheckReporter } from "./github/checks";
import { credentialsFromConfig, type GitHubCredentials } from "./github/credentials";
import { handleWebhook } from "./github/webhook";
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

/**
 * Wires the default dependency graph; tests override pieces (e.g. an in-memory DB, a fake GitHub).
 * The check reporter is attached to the hub, so GitHub-triggered runs report as soon as events flow.
 */
export function createDeps(config: ServerConfig, opts: DepsOptions = {}): AppDeps {
  const db = opts.db ?? createDb(join(config.dataDir, "orch.sqlite"));
  const hub = new Hub();
  const runs = new RunService(db, hub);
  const gh = config.github;
  const deps: Omit<AppDeps, "checks"> = {
    config,
    db,
    hub,
    runs,
    scheduler: new Scheduler(runs, Date.now, {
      maxConcurrentPerRepo: gh?.maxConcurrentPerRepo ?? DEFAULT_MAX_CONCURRENT_PER_REPO,
    }),
    credentials: opts.credentials ?? credentialsFromConfig(gh),
    github: opts.github ?? (gh ? new GitHubApi(fetch, gh.apiBaseUrl, gh.webBaseUrl) : new GitHubApi()),
    webhooks: gh?.kind === "app" ? new Webhooks({ secret: gh.webhookSecret }) : null,
    webDist: opts.webDist ?? DEFAULT_WEB_DIST,
  };
  const checks = new CheckReporter(deps);
  checks.attach();
  return { ...deps, checks };
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

  // WebSocket routes are registered before the REST sub-apps so `/api/runs/:id/stream` is not shadowed;
  // they authenticate themselves (runner token / session cookie) and close with 4401.
  registerBrowserWs(app, deps);
  registerRunnerWs(app, deps);

  app.get("/api/me", (c) => {
    const me: MeResponse = { authMode: deps.config.auth.mode, user: sessionUser(deps, c) };
    return c.json(me);
  });
  app.use("/api/*", requireSession(deps));

  const runs = runRoutes(deps);
  const runners = runnerRoutes(deps);
  app.route("/api/flows", flowRoutes(deps));
  app.route("/api/flows", runs.flowRuns);
  app.route("/api/runs", runs.runs);
  app.route("/api/runners", runners.runners);
  app.route("/api/catalog", runners.catalog);
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  app.all("/runner/*", (c) => c.json({ error: "Not found" }, 404));

  if (deps.config.auth.mode === "github") app.route("/auth", oauthRoutes(deps));

  const webhooks = deps.webhooks;
  if (webhooks) {
    app.post("/github/webhook", async (c) => {
      const res = await handleWebhook(deps, webhooks, {
        event: c.req.header("x-github-event"),
        deliveryId: c.req.header("x-github-delivery"),
        signature: c.req.header("x-hub-signature-256"),
        body: await c.req.text(),
      });
      return c.json(res.body, res.status);
    });
  }

  app.get("*", (c) => serveWeb(deps.webDist, c.req.path));

  return app;
}
