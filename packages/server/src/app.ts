import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { THEME_COOKIE, type MeResponse, type ThemesResponse } from "@orch/protocol";
import { Webhooks } from "@octokit/webhooks";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
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
import { ThemeStore } from "./themes";
import { registerBrowserWs } from "./ws/browser";
import { registerRunnerWs } from "./ws/runner";

export const DEFAULT_WEB_DIST = join(import.meta.dir, "../../web/dist");
export const DEFAULT_THEMES_DIR = join(import.meta.dir, "../../web/themes");

export interface DepsOptions {
  db?: Db;
  credentials?: GitHubCredentials;
  github?: GitHubApi;
  webDist?: string;
  builtinThemesDir?: string;
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
    themes: new ThemeStore(opts.builtinThemesDir ?? DEFAULT_THEMES_DIR, config.ui.themesDir),
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

/**
 * The page's render-blocking `/theme.css`: the `orch_theme` cookie's theme if it exists, else `ui.theme`, else
 * empty (built-in styles). Cached per cookie and always revalidated, so a newly picked or edited theme applies.
 */
function serveTheme(deps: AppDeps, cookie: string | undefined): Response {
  const { theme } = deps.config.ui;
  let file = cookie === undefined ? null : deps.themes.resolve(cookie);
  if (file === null && theme !== null) {
    file = deps.themes.resolve(theme);
    if (file === null) console.warn(`[themes] ui.theme "${theme}" not found; serving the built-in default`);
  }
  let css = "";
  if (file !== null) {
    try {
      css = readFileSync(file, "utf8");
    } catch (err) {
      // Removed between resolve and read.
      console.warn(`[themes] reading ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return new Response(css, {
    headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache", Vary: "Cookie" },
  });
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
  app.get("/api/themes", (c) => {
    const { theme } = deps.config.ui;
    const res: ThemesResponse = {
      themes: deps.themes.list(),
      // A configured theme whose file is gone is served as the built-in default; say so.
      defaultTheme: theme !== null && deps.themes.resolve(theme) !== null ? theme : null,
    };
    return c.json(res);
  });

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

  // Public like the rest of the web bundle: index.html loads it before any session exists.
  app.get("/theme.css", (c) => serveTheme(deps, getCookie(c, THEME_COOKIE)));
  app.get("*", (c) => serveWeb(deps.webDist, c.req.path));

  return app;
}
