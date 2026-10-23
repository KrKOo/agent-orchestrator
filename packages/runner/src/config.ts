import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export interface RunnerConfig {
  serverUrl: string;
  token: string;
  runnerId: string;
  labels: string[];
  maxConcurrentJobs: number;
  /** Absolute, realpath'd at load; missing roots are dropped with a warning. */
  allowedRoots: string[];
  acceptUntrusted: boolean;
  /** Absolute, `~` expanded, created at load. */
  dataDir: string;
  /** Absolute, `~` expanded. */
  skillDirs: string[];
  /** Absolute, `~` expanded. */
  commandDirs: string[];
  ports: { mcp: number; broker: number; gateway: number };
  hostBind: string;
  dockerRuntime?: string;
  git: { authorName?: string; authorEmail?: string };
}

export const DEFAULT_CONFIG_PATH = "~/.agent-orchestrator/runner.json";

const Port = z.number().int().min(1).max(65535);

const RawConfig = z.object({
  serverUrl: z.string().url().default("ws://127.0.0.1:7800/runner/ws"),
  token: z.string().min(1),
  runnerId: z.string().min(1),
  labels: z.array(z.string()).default([]),
  maxConcurrentJobs: z.number().int().min(1).default(2),
  allowedRoots: z.array(z.string()).default([]),
  acceptUntrusted: z.boolean().default(false),
  dataDir: z.string().default("~/.agent-orchestrator/runner"),
  skillDirs: z.array(z.string()).default(["~/.omp/agent/skills", "~/.claude/skills"]),
  commandDirs: z.array(z.string()).default(["~/.omp/agent/commands", "~/.claude/commands"]),
  ports: z
    .object({ mcp: Port.default(7802), broker: Port.default(7803), gateway: Port.default(7804) })
    .default({ mcp: 7802, broker: 7803, gateway: 7804 }),
  hostBind: z.string().min(1).default("127.0.0.1"),
  dockerRuntime: z.string().min(1).optional(),
  git: z.object({ authorName: z.string().optional(), authorEmail: z.string().optional() }).default({}),
});

/** Expands a leading `~` and resolves to an absolute path. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

export async function loadConfig(path?: string): Promise<RunnerConfig> {
  const configPath = expandHome(path ?? process.env.ORCH_RUNNER_CONFIG ?? DEFAULT_CONFIG_PATH);
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    throw new Error(
      `Runner config not found at ${configPath}. Create it (or set ORCH_RUNNER_CONFIG) with at least ` +
        `{"token": "<from: bun packages/server/src/main.ts runner-token create --name <n>>", "runnerId": "<runner id>", ` +
        `"allowedRoots": ["/abs/path"]}.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch (err) {
    throw new Error(`Runner config ${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = RawConfig.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`Invalid runner config ${configPath} (required fields: token, runnerId): ${issues}`);
  }
  const raw = parsed.data;

  const allowedRoots: string[] = [];
  for (const root of raw.allowedRoots) {
    const abs = expandHome(root);
    if (!isAbsolute(root) && !root.startsWith("~")) {
      console.warn(`[config] allowedRoots entry ${JSON.stringify(root)} is not absolute; dropped`);
      continue;
    }
    if (!existsSync(abs)) {
      console.warn(`[config] allowedRoots entry ${abs} does not exist; dropped`);
      continue;
    }
    const real = realpathSync(abs);
    if (!allowedRoots.includes(real)) allowedRoots.push(real);
  }

  mkdirSync(expandHome(raw.dataDir), { recursive: true });
  // Realpath'd so bind-mount sources and in-container paths agree (e.g. macOS /tmp → /private/tmp).
  const dataDir = realpathSync(expandHome(raw.dataDir));

  return {
    serverUrl: raw.serverUrl,
    token: raw.token,
    runnerId: raw.runnerId,
    labels: raw.labels,
    maxConcurrentJobs: raw.maxConcurrentJobs,
    allowedRoots,
    acceptUntrusted: raw.acceptUntrusted,
    dataDir,
    skillDirs: raw.skillDirs.map(expandHome),
    commandDirs: raw.commandDirs.map(expandHome),
    ports: raw.ports,
    hostBind: raw.hostBind,
    dockerRuntime: raw.dockerRuntime,
    git: raw.git,
  };
}
