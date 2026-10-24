import type { ModelEntry } from "@orch/protocol";
import type { Subprocess } from "bun";
import { z } from "zod";
import type { RunnerConfig } from "./config";

export interface Gateway {
  /** Gateway bearer token: the only secret handed to sandboxes. */
  token: string;
  /** Providers the gateway can route (from `/v1/models`); `fallback` when that endpoint is unusable. */
  listGatewayProviders(fallback: string[]): Promise<string[]>;
  /** Routable models (from `/v1/models`); `fallback` when that endpoint is unusable. */
  listGatewayModels(fallback: ModelEntry[]): Promise<ModelEntry[]>;
  stop(): Promise<void>;
}

const OMP = "omp";
const HEALTH_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 20_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A child that stayed up this long resets the restart backoff. */
const STABLE_UPTIME_MS = 30_000;
const PROVIDER_CACHE_MS = 15 * 60_000;

export class PortInUseError extends Error {}

/** True when nothing accepts connections on `host:port` and it can be bound right now. */
async function portFree(host: string, port: number): Promise<boolean> {
  try {
    // A wildcard listener (e.g. 0.0.0.0) may not block binding the specific host, but it accepts connects.
    const socket = await Bun.connect({ hostname: host, port, socket: { data() {} } });
    socket.end();
    return false;
  } catch {
    // refused: nobody listening
  }
  try {
    const listener = Bun.listen({ hostname: host, port, socket: { data() {} } });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function pipeLines(stream: ReadableStream<Uint8Array>, prefix: string): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (line) console.log(`${prefix} ${line}`);
      }
    }
  } catch {
    // stream torn down with the process
  }
  if (buf.trim()) console.log(`${prefix} ${buf.trim()}`);
}

async function waitHealthy(url: string, child: () => Subprocess | null, name: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const proc = child();
    if (proc && proc.exitCode !== null) throw new Error(`${name} exited with code ${proc.exitCode} before becoming healthy`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(HEALTH_POLL_MS);
  }
  throw new Error(`${name} not healthy at ${url} after ${HEALTH_TIMEOUT_MS / 1000}s`);
}

/** Runs one long-lived omp child, restarting it with exponential backoff when it dies. */
class Supervised {
  proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private stopped = false;
  private backoff = BACKOFF_MIN_MS;
  private restartTimer: Timer | undefined;

  constructor(
    readonly name: string,
    private readonly argv: string[],
    private readonly env: Record<string, string | undefined>,
    private readonly healthUrl: string,
  ) {}

  spawn(): void {
    const startedAt = Date.now();
    const proc = Bun.spawn(this.argv, { env: this.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    void pipeLines(proc.stdout, `[${this.name}]`);
    void pipeLines(proc.stderr, `[${this.name}]`);
    void proc.exited.then((code) => {
      if (this.stopped || this.proc !== proc) return;
      this.proc = null;
      if (Date.now() - startedAt >= STABLE_UPTIME_MS) this.backoff = BACKOFF_MIN_MS;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      console.error(`[gateway] ${this.name} exited with code ${code}; restarting in ${delay / 1000}s`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.stopped) return;
        this.spawn();
        waitHealthy(this.healthUrl, () => this.proc, this.name).then(
          () => console.log(`[gateway] ${this.name} healthy again`),
          (err) => console.error(`[gateway] ${(err as Error).message}`),
        );
      }, delay);
    });
  }

  async start(): Promise<void> {
    this.spawn();
    await waitHealthy(this.healthUrl, () => this.proc, this.name);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (!exited) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }
}

async function readGatewayToken(env: Record<string, string | undefined>): Promise<string> {
  const proc = Bun.spawn([OMP, "auth-gateway", "token"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`omp auth-gateway token failed (exit ${code}): ${stderr.trim()}`);
  const lines = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const token = lines.at(-1);
  if (!token) throw new Error("omp auth-gateway token printed no token");
  return token;
}

const ModelsResponse = z.object({ data: z.array(z.looseObject({ id: z.unknown() })) });

/** Routable `provider/model` ids with display names; null when the response is unusable. */
function modelsFrom(body: unknown): ModelEntry[] | null {
  const parsed = ModelsResponse.safeParse(body);
  if (!parsed.success) return null;
  const out: ModelEntry[] = [];
  for (const { id, display_name } of parsed.data.data) {
    if (typeof id !== "string" || !id.includes("/")) continue;
    out.push({ id, name: typeof display_name === "string" && display_name ? display_name : id });
  }
  return out.length ? out : null;
}

/**
 * Starts `omp auth-broker serve` and `omp auth-gateway serve` on `hostBind`, waits for both to be healthy,
 * and reads the gateway bearer token. Throws `PortInUseError` when a configured port is taken.
 */
export async function startGateway(cfg: RunnerConfig): Promise<Gateway> {
  const host = cfg.hostBind;
  const { broker: brokerPort, gateway: gatewayPort } = cfg.ports;
  for (const [key, port, label] of [
    ["broker", brokerPort, "auth-broker"],
    ["gateway", gatewayPort, "auth-gateway"],
  ] as const) {
    if (!(await portFree(host, port))) {
      throw new PortInUseError(`Port ${port} in use (${label}); set ports.${key} in runner.json`);
    }
  }

  const brokerUrl = `http://${host}:${brokerPort}`;
  const gatewayUrl = `http://${host}:${gatewayPort}`;
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  delete baseEnv.OMP_AUTH_BROKER_URL;
  const gatewayEnv = { ...baseEnv, OMP_AUTH_BROKER_URL: brokerUrl };

  const broker = new Supervised(
    "auth-broker",
    [OMP, "auth-broker", "serve", `--bind=${host}:${brokerPort}`],
    baseEnv,
    `${brokerUrl}/v1/healthz`,
  );
  const gateway = new Supervised(
    "auth-gateway",
    [OMP, "auth-gateway", "serve", `--bind=${host}:${gatewayPort}`],
    gatewayEnv,
    `${gatewayUrl}/healthz`,
  );

  const stop = async () => {
    await gateway.stop();
    await broker.stop();
  };

  let token: string;
  try {
    await broker.start();
    await gateway.start();
    token = await readGatewayToken(gatewayEnv);
  } catch (err) {
    await stop();
    throw err;
  }
  console.log(`[gateway] auth-broker ${brokerUrl} and auth-gateway ${gatewayUrl} ready`);

  let cache: { models: ModelEntry[]; providers: string[]; at: number } | null = null;
  // Null on fetch/parse failure OR when the response has no `provider/`-prefixed ids (modelsFrom null):
  // callers then use their fallback instead of an empty list, so an unparsable gateway can't wipe
  // the flow's own providers/models from routing decisions and catalog advertisement.
  const fetchModels = async (): Promise<{ models: ModelEntry[]; providers: string[] } | null> => {
    if (cache && Date.now() - cache.at < PROVIDER_CACHE_MS) return cache;
    let models: ModelEntry[] | null = null;
    try {
      const res = await fetch(`${gatewayUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) models = modelsFrom(await res.json());
    } catch {
      models = null;
    }
    if (!models) return null;
    cache = { models, providers: providersFromIds(models), at: Date.now() };
    return cache;
  };

  return {
    token,
    async listGatewayProviders(fallback: string[]): Promise<string[]> {
      const found = await fetchModels();
      if (!found) {
        console.warn("[gateway] gateway /v1/models unusable; routing flow model providers only");
        return [...new Set(fallback)].sort();
      }
      return found.providers;
    },
    async listGatewayModels(fallback: ModelEntry[]): Promise<ModelEntry[]> {
      const found = await fetchModels();
      if (!found) return dedupeModels(fallback);
      return found.models;
    },
    stop,
  };
}

/** Provider prefixes of model ids (`<provider>/<model>`). */
function providersFromIds(models: ModelEntry[]): string[] {
  const providers = new Set<string>();
  for (const { id } of models) {
    const slash = id.indexOf("/");
    if (slash > 0) providers.add(id.slice(0, slash));
  }
  return [...providers].sort();
}

/** Distinct models by id, keeping the first name seen. */
function dedupeModels(models: ModelEntry[]): ModelEntry[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
