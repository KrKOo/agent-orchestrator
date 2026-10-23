import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const AuthConfig = z.discriminatedUnion("mode", [z.object({ mode: z.literal("none") })]);

const GitHubConfig = z.discriminatedUnion("kind", [z.object({ kind: z.literal("pat"), token: z.string().min(1) })]);

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

export interface ServerConfig {
  host: string;
  port: number;
  /** Absolute; relative paths in the file resolve against the config file's directory. */
  dataDir: string;
  /** Normalised origin form, no trailing slash. */
  publicUrl: string;
  auth: AuthConfig;
  github: GitHubConfig | null;
}

export function parseServerConfig(raw: unknown, baseDir: string): ServerConfig {
  const parsed = ServerConfigFile.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid server config: ${msg}`);
  }
  const cfg = parsed.data;
  const sep = cfg.bind.lastIndexOf(":");
  return {
    host: cfg.bind.slice(0, sep),
    port: Number(cfg.bind.slice(sep + 1)),
    dataDir: resolve(baseDir, cfg.dataDir),
    publicUrl: new URL(cfg.publicUrl).origin,
    auth: cfg.auth,
    github: cfg.github,
  };
}

/** Reads `ORCH_SERVER_CONFIG` (default `./orch.server.json`); a missing file means all defaults. */
export function loadServerConfig(path = process.env.ORCH_SERVER_CONFIG ?? "./orch.server.json"): ServerConfig {
  const abs = resolve(path);
  const raw = existsSync(abs) ? JSON.parse(readFileSync(abs, "utf8")) : {};
  return parseServerConfig(raw, dirname(abs));
}
