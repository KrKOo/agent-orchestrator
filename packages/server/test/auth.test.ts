import { describe, expect, test } from "bun:test";
import type { MeResponse, RunRow } from "@orch/protocol";
import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { websocket } from "hono/bun";
import { createApp } from "../src/app";
import { upsertUser } from "../src/auth/github-oauth";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession, verifySession } from "../src/auth/session";
import { schema } from "../src/db";
import { AppCredentials, TOKEN_REFRESH_MARGIN_MS } from "../src/github/credentials";
import { hashToken } from "../src/ws/runner";
import { addRun, TEST_WEB, testDeps } from "./helpers";

const SESSION_SECRET = "s".repeat(40);
const GITHUB_AUTH = {
  publicUrl: "https://orch.example.com",
  auth: { mode: "github", allowedLogins: ["Alice"], sessionSecret: SESSION_SECRET },
  github: {
    kind: "app",
    appId: 1,
    privateKeyPath: "/nonexistent.pem",
    clientId: "cid",
    clientSecret: "csecret",
    webhookSecret: "whsec",
  },
};
const ALICE = { id: "1001", login: "alice" };

/** Fake GitHub OAuth: the code names the login GitHub reports. */
function oauthFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${TEST_WEB}/login/oauth/access_token`) {
      const body = JSON.parse(String(init?.body)) as { code: string; client_secret: string };
      if (body.client_secret !== "csecret") return Response.json({ error: "bad_client" });
      return Response.json({ access_token: `user-token-${body.code}` });
    }
    if (url.endsWith("/user")) {
      const login = new Headers(init?.headers).get("authorization")!.replace("Bearer user-token-", "");
      return Response.json({ id: login === "alice" ? 1001 : 666, login });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
}

function githubAuthApp(calls: string[] = []) {
  const deps = testDeps({ config: GITHUB_AUTH, fetch: oauthFetch(calls), credentials: { configured: false, tokenFor: async () => "x" } });
  return { deps, app: createApp(deps) };
}

const cookieHeader = (value: string) => ({ Cookie: `${SESSION_COOKIE}=${value}` });

describe("session cookie", () => {
  test("round-trips, rejects tampering, foreign secrets and expiry", () => {
    const now = 1_000_000;
    const cookie = signSession(SESSION_SECRET, ALICE, now);
    expect(verifySession(SESSION_SECRET, cookie, now + 1000)).toEqual(ALICE);
    const [data, sig] = cookie.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ uid: "1", login: "alice", exp: now + SESSION_TTL_MS })).toString("base64url");
    expect(verifySession(SESSION_SECRET, `${forged}.${sig}`, now)).toBeNull();
    expect(verifySession(SESSION_SECRET, `${data}.${sig.slice(0, -2)}AA`, now)).toBeNull();
    expect(verifySession("t".repeat(40), cookie, now)).toBeNull();
    expect(verifySession(SESSION_SECRET, cookie, now + SESSION_TTL_MS)).toBeNull();
    expect(verifySession(SESSION_SECRET, "garbage", now)).toBeNull();
  });
});

describe("GitHub auth mode", () => {
  test("/api/* needs a valid session; /api/me reports the user", async () => {
    const { deps, app } = githubAuthApp();
    expect(await (await app.request("/api/me")).json()).toEqual({ authMode: "github", user: null } satisfies MeResponse);
    const anon = await app.request("/api/flows");
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: "unauthorized" });

    const cookie = signSession(SESSION_SECRET, ALICE);
    // A validly signed session for a user that never logged in (no row) is not enough.
    expect((await app.request("/api/flows", { headers: cookieHeader(cookie) })).status).toBe(401);
    upsertUser(deps, ALICE);
    expect((await app.request("/api/flows", { headers: cookieHeader(cookie) })).status).toBe(200);
    expect(await (await app.request("/api/me", { headers: cookieHeader(cookie) })).json()).toEqual({ authMode: "github", user: ALICE });

    const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await app.request("/api/flows", { headers: cookieHeader(tampered) })).status).toBe(401);
    // Logins removed from allowedLogins lose access even with a valid cookie.
    const bob = { id: "2002", login: "bob" };
    upsertUser(deps, bob);
    expect((await app.request("/api/runs", { headers: cookieHeader(signSession(SESSION_SECRET, bob)) })).status).toBe(401);
    // Non-API paths (SPA, webhook) are not behind the session guard.
    expect((await app.request("/runs/x")).status).toBe(404); // web UI not built in tests
  });

  test("login redirects to GitHub; callback admits allowed logins, 403s the rest", async () => {
    const calls: string[] = [];
    const { deps, app } = githubAuthApp(calls);
    const login = await app.request("/auth/login");
    expect(login.status).toBe(302);
    const location = new URL(login.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${TEST_WEB}/login/oauth/authorize`);
    expect(location.searchParams.get("client_id")).toBe("cid");
    expect(location.searchParams.get("redirect_uri")).toBe("https://orch.example.com/auth/callback");
    const state = location.searchParams.get("state")!;
    expect(login.headers.get("set-cookie")).toContain(`orch_oauth_state=${state}`);

    const callback = (code: string, cookieState = state, queryState = state) =>
      app.request(`/auth/callback?code=${code}&state=${queryState}`, { headers: { Cookie: `orch_oauth_state=${cookieState}` } });

    expect((await callback("alice", "other")).status).toBe(400);
    expect(calls).toEqual([]);

    const denied = await callback("mallory");
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("Not allowed");
    expect(denied.headers.get("set-cookie") ?? "").not.toContain(`${SESSION_COOKIE}=`);

    const ok = await callback("alice");
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
    const setCookie = ok.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(deps.db.select().from(schema.users).all()).toMatchObject([{ id: "1001", login: "alice" }]);
    const session = setCookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1);
    expect(verifySession(SESSION_SECRET, session)).toEqual(ALICE);

    const logout = await app.request("/auth/logout", { method: "POST" });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
  });

  test("runs and runner tokens are owned by the session user", async () => {
    const { deps, app } = githubAuthApp();
    upsertUser(deps, ALICE);
    const headers = { ...cookieHeader(signSession(SESSION_SECRET, ALICE)), "Content-Type": "application/json" };
    const created = await app.request("/api/runners", { method: "POST", headers, body: JSON.stringify({ name: "laptop", labels: ["mac"] }) });
    expect(created.status).toBe(201);
    const { runnerId, token } = (await created.json()) as { runnerId: string; token: string };
    const row = deps.db.select().from(schema.runners).where(eq(schema.runners.id, runnerId)).get()!;
    expect(row).toMatchObject({ name: "laptop", labels: ["mac"], ownerUserId: "1001", tokenHash: hashToken(token) });
    expect((await app.request("/api/runners", { method: "POST", headers, body: JSON.stringify({}) })).status).toBe(400);

    const flow = await app.request("/api/flows", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "f",
        workspace: { kind: "local_path", path: "/Users/me/Documents/repo" },
        harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
        steps: [{ id: "a", name: "A", kind: "prompt", prompt: "hi" }],
      }),
    });
    const { id: flowId } = (await flow.json()) as { id: string };
    const run = await app.request(`/api/flows/${flowId}/runs`, { method: "POST", headers, body: JSON.stringify({ inputs: {} }) });
    expect(((await run.json()) as RunRow).createdBy).toBe("1001");
  });

  test("auth mode none: /api/me has no user and runner tokens have no owner", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    expect(await (await app.request("/api/me")).json()).toEqual({ authMode: "none", user: null });
    const created = await app.request("/api/runners", { method: "POST", body: JSON.stringify({ name: "x" }) });
    const { runnerId } = (await created.json()) as { runnerId: string };
    expect(deps.db.select().from(schema.runners).where(eq(schema.runners.id, runnerId)).get()!.ownerUserId).toBeNull();
  });

  test("browser stream: 4401 without a session, 4403 for a foreign Origin", async () => {
    const { deps, app } = githubAuthApp();
    upsertUser(deps, ALICE);
    const runId = addRun(deps);
    deps.runs.terminate(runId, "cancelled"); // one persisted event, replayed to admitted subscribers
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    try {
      /** `event` once the replay arrives, or the close code the server picked. */
      const connect = (headers: Record<string, string>): Promise<string> => {
        const { promise, resolve } = Promise.withResolvers<string>();
        // Bun's WebSocket accepts `{headers}`; the DOM constructor type does not model it.
        const bunOptions = { headers } as unknown as string[];
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/runs/${runId}/stream`, bunOptions);
        ws.onmessage = () => {
          resolve("event");
          ws.close();
        };
        ws.onclose = (e) => resolve(String(e.code));
        return promise;
      };
      expect(await connect({})).toBe("4401");
      const cookie = cookieHeader(signSession(SESSION_SECRET, ALICE));
      expect(await connect({ ...cookie, Origin: "https://evil.example" })).toBe("4403");
      expect(await connect({ ...cookie, Origin: "https://orch.example.com" })).toBe("event");
    } finally {
      server.stop(true);
    }
  });
});

describe("AppCredentials", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  test("looks up the installation, mints repo-scoped tokens per access and caches until 5 min before expiry", async () => {
    const calls: { method: string; path: string; auth: string; body: unknown }[] = [];
    let now = Date.parse("2026-01-01T00:00:00Z");
    let minted = 0;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const full = new URL(req.url).pathname;
      if (!full.startsWith("/api/v3/")) return Response.json({ message: "wrong base" }, { status: 400 });
      const path = full.slice("/api/v3".length);
      calls.push({ method: req.method, path, auth: req.headers.get("authorization") ?? "", body: req.body ? await req.json() : null });
      if (path === "/repos/o/r/installation") return Response.json({ id: 55 });
      if (path === "/repos/o/missing/installation") return Response.json({ message: "Not Found" }, { status: 404 });
      if (/^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
        minted++;
        return Response.json({ token: `ghs_${minted}`, expires_at: new Date(now + 60 * 60_000).toISOString() }, { status: 201 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    }) as typeof fetch;
    const creds = new AppCredentials({ appId: 1, privateKey, apiBaseUrl: "https://gh.test/api/v3", fetch: fetchFn, now: () => now });

    expect(await creds.tokenFor("o/r", "read")).toBe("ghs_1");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /repos/o/r/installation", "POST /app/installations/55/access_tokens"]);
    expect(calls[0]!.auth).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/i); // app JWT
    expect(calls[1]!.body).toEqual({
      repositories: ["r"],
      permissions: { contents: "read", pull_requests: "read", issues: "read" },
    });

    expect(await creds.tokenFor("o/r", "read")).toBe("ghs_1"); // cached
    expect(await creds.tokenFor("o/r", "write")).toBe("ghs_2");
    expect(calls.at(-1)!.body).toEqual({ repositories: ["r"], permissions: { contents: "write", pull_requests: "write", issues: "read" } });
    expect(await creds.tokenFor("o/r", "report", 77)).toBe("ghs_3");
    expect(calls.at(-1)!.path).toBe("/app/installations/77/access_tokens");
    expect(calls.at(-1)!.body).toEqual({ repositories: ["r"], permissions: { checks: "write", pull_requests: "write" } });
    expect(calls.filter((c) => c.path.endsWith("/installation"))).toHaveLength(1); // installation lookup cached

    now += 60 * 60_000 - TOKEN_REFRESH_MARGIN_MS + 1;
    expect(await creds.tokenFor("o/r", "read")).toBe("ghs_4");

    await expect(creds.tokenFor("o/missing", "read")).rejects.toThrow("GitHub App is not installed on o/missing");
  });
});
