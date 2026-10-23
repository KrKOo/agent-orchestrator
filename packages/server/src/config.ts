import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const AuthConfig = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("github"),
    /** GitHub logins allowed to sign in (compared case-insensitively). */
    allowedLogins: z.array(z.string().min(1)).min(1, "list at least one login"),
    /** HMAC-SHA256 key for the `orch_session` cookie. */
    sessionSecret: z.string().min(32, "sessionSecret must be at least 32 characters"),
  }),
]);

const trimSlash = (u: string): string => u.replace(/\/+$/, "");

/** Shared by every credential kind; the base URLs exist so tests and smokes can point at a fake GitHub. */
const GitHubCommon = {
  apiBaseUrl: z.url().default("https://api.github.com").transform(trimSlash),
  webBaseUrl: z.url().default("https://github.com").transform(trimSlash),
  /** At most this many non-terminal GitHub-triggered runs per repo are assigned at once. */
  maxConcurrentPerRepo: z.number().int().min(1).default(2),
};

const GitHubConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pat"), token: z.string().min(1), ...GitHubCommon }),
  z.object({
    kind: z.literal("app"),
    appId: z.number().int().positive(),
    /** PEM private key of the App; relative paths resolve against the config file's directory. */
    privateKeyPath: z.string().min(1),
    /** The App's user-authorization (OAuth) client credentials, used for login. */
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    webhookSecret: z.string().min(1),
    ...GitHubCommon,
  }),
]);

export const ServerConfigFile = z.object({
  bind: z
    .string()
    .regex(/^[^:]+:\d+$/, "bind must be host:port")
    .default("127.0.0.1:7800"),
  dataDir: z.string().min(1).default("./data"),
  publicUrl: z.url().default("http://127.0.0.1:7800"),
  auth: AuthConfig.default({ mode: "none" }),
  github: GitHubConfig.nullable().default(null),
});

export type AuthConfig = z.infer<typeof AuthConfig>;
export type GitHubConfig = z.infer<typeof GitHubConfig>;

export const DEFAULT_MAX_CONCURRENT_PER_REPO = 2;

export interface ServerConfig {
  host: string;
  port: number;
  /** Absolute; relative paths in the file resolve against the config file's directory. */
  dataDir: string;
  /** Normalised origin form, no trailing slash. */
  publicUrl: string;
  auth: AuthConfig;
  /** `privateKeyPath` is absolute. */
  github: GitHubConfig | null;
}

export function parseServerConfig(raw: unknown, baseDir: string): ServerConfig {
  const parsed = ServerConfigFile.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid server config: ${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.auth.mode === "github" && cfg.github?.kind !== "app") {
    throw new Error('Invalid server config: auth.mode "github" requires github.kind "app" (its clientId/clientSecret are used for login)');
  }
  const sep = cfg.bind.lastIndexOf(":");
  return {
    host: cfg.bind.slice(0, sep),
    port: Number(cfg.bind.slice(sep + 1)),
    dataDir: resolve(baseDir, cfg.dataDir),
    publicUrl: new URL(cfg.publicUrl).origin,
    auth: cfg.auth,
    github: cfg.github?.kind === "app" ? { ...cfg.github, privateKeyPath: resolve(baseDir, cfg.github.privateKeyPath) } : cfg.github,
  };
}

/** Reads `ORCH_SERVER_CONFIG` (default `./orch.server.json`); a missing file means all defaults. */
export function loadServerConfig(path = process.env.ORCH_SERVER_CONFIG ?? "./orch.server.json"): ServerConfig {
  const abs = resolve(path);
  const raw = existsSync(abs) ? JSON.parse(readFileSync(abs, "utf8")) : {};
  return parseServerConfig(raw, dirname(abs));
}
