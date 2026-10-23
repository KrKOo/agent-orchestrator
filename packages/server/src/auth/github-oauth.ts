import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import { clearSessionCookie, loginAllowed, setSessionCookie, type SessionUser } from "./session";

const { users } = schema;

export const STATE_COOKIE = "orch_oauth_state";
const STATE_TTL_S = 600;

/** Inserts or refreshes the user row; a stale row holding the same (renamed-away) login is dropped. */
export function upsertUser(deps: Pick<AppDeps, "db">, user: SessionUser): void {
  deps.db.transaction((tx) => {
    tx.delete(users)
      .where(and(eq(users.login, user.login), ne(users.id, user.id)))
      .run();
    tx.insert(users)
      .values({ id: user.id, login: user.login, createdAt: Date.now() })
      .onConflictDoUpdate({ target: users.id, set: { login: user.login } })
      .run();
  });
}

/** `/auth/login`, `/auth/callback`, `/auth/logout`; only mounted with `auth.mode === "github"`. */
export function oauthRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const { auth, github, publicUrl } = deps.config;
  if (auth.mode !== "github" || github?.kind !== "app") throw new Error("GitHub login needs auth.mode github and a GitHub App");
  const redirectUri = `${publicUrl}/auth/callback`;
  const stateCookie = { httpOnly: true, secure: publicUrl.startsWith("https:"), sameSite: "Lax" as const, path: "/auth" };

  app.get("/login", (c) => {
    const state = randomBytes(24).toString("base64url");
    setCookie(c, STATE_COOKIE, state, { ...stateCookie, maxAge: STATE_TTL_S });
    return c.redirect(deps.github.authorizeUrl(github.clientId, redirectUri, state), 302);
  });

  app.get("/callback", async (c) => {
    const expected = getCookie(c, STATE_COOKIE);
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code");
    deleteCookie(c, STATE_COOKIE, stateCookie);
    const a = Buffer.from(expected ?? "");
    const b = Buffer.from(state);
    const stateOk = a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
    if (!stateOk || !code) return c.text("Invalid OAuth state", 400);

    let user: SessionUser;
    try {
      const token = await deps.github.exchangeOAuthCode(github.clientId, github.clientSecret, code, redirectUri);
      const gh = await deps.github.getUser(token);
      user = { id: String(gh.id), login: gh.login };
    } catch (err) {
      console.error("[auth] GitHub login failed:", err instanceof Error ? err.message : err);
      return c.text("GitHub login failed", 502);
    }
    if (!loginAllowed(auth.allowedLogins, user.login)) {
      console.warn(`[auth] login ${user.login} not allowed`);
      return c.text("Not allowed", 403);
    }
    upsertUser(deps, user);
    setSessionCookie(c, deps, auth.sessionSecret, user);
    console.log(`[auth] ${user.login} logged in`);
    return c.redirect("/", 302);
  });

  app.post("/logout", (c) => {
    clearSessionCookie(c, deps);
    return c.body(null, 204);
  });

  return app;
}
