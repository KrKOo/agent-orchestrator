import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { schema } from "../db";
import type { AppDeps } from "../deps";

export const SESSION_COOKIE = "orch_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

export interface SessionUser {
  id: string;
  login: string;
}

declare module "hono" {
  interface ContextVariableMap {
    /** Set by `requireSession`; null with `auth.mode === "none"`. */
    user: SessionUser | null;
  }
}

const SessionPayload = z.object({ uid: z.string(), login: z.string(), exp: z.number() });

function mac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/** `<base64url(JSON {uid, login, exp})>.<base64url(HMAC-SHA256)>` */
export function signSession(secret: string, user: SessionUser, now = Date.now()): string {
  const data = Buffer.from(JSON.stringify({ uid: user.id, login: user.login, exp: now + SESSION_TTL_MS })).toString("base64url");
  return `${data}.${mac(secret, data).toString("base64url")}`;
}

/** The signed user, or null for a malformed, tampered or expired value. */
export function verifySession(secret: string, value: string, now = Date.now()): SessionUser | null {
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const data = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = mac(secret, data);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  let payload: z.infer<typeof SessionPayload>;
  try {
    payload = SessionPayload.parse(JSON.parse(Buffer.from(data, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (payload.exp <= now) return null;
  return { id: payload.uid, login: payload.login };
}

export function loginAllowed(allowedLogins: string[], login: string): boolean {
  return allowedLogins.some((l) => l.toLowerCase() === login.toLowerCase());
}

/**
 * The logged-in user behind the request's `orch_session` cookie (null when absent/invalid, when the login
 * is no longer allowed, or the user row is gone). Always null with `auth.mode === "none"`.
 */
export function sessionUser(deps: Pick<AppDeps, "config" | "db">, c: Context): SessionUser | null {
  const auth = deps.config.auth;
  if (auth.mode !== "github") return null;
  const cookie = getCookie(c, SESSION_COOKIE);
  const user = cookie ? verifySession(auth.sessionSecret, cookie) : null;
  if (!user || !loginAllowed(auth.allowedLogins, user.login)) return null;
  const row = deps.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, user.id)).get();
  return row ? user : null;
}

/** `/api/*` guard: with GitHub auth a valid session is required (401 otherwise); sets `c.var.user`. */
export function requireSession(deps: Pick<AppDeps, "config" | "db">): MiddlewareHandler {
  return async (c, next) => {
    if (deps.config.auth.mode === "none") {
      c.set("user", null);
      return next();
    }
    const user = sessionUser(deps, c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    return next();
  };
}

function cookieOptions(deps: Pick<AppDeps, "config">) {
  return {
    httpOnly: true,
    secure: deps.config.publicUrl.startsWith("https:"),
    sameSite: "Lax" as const,
    path: "/",
  };
}

export function setSessionCookie(c: Context, deps: Pick<AppDeps, "config">, secret: string, user: SessionUser): void {
  setCookie(c, SESSION_COOKIE, signSession(secret, user), { ...cookieOptions(deps), maxAge: SESSION_TTL_MS / 1000 });
}

export function clearSessionCookie(c: Context, deps: Pick<AppDeps, "config">): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions(deps));
}
