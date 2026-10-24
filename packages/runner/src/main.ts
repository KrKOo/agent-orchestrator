import { WIRE_PROTOCOL, type ModelEntry, type RunnerMessage, type ServerMessage } from "@orch/protocol";
import { join } from "node:path";
import pkg from "../package.json";
import { loadConfig, type RunnerConfig } from "./config";
import { Connection } from "./connection";
import { fsList } from "./fs-rpc";
import { type Gateway, PortInUseError, startGateway } from "./gateway";
import { JobManager } from "./job";
import { Library } from "./library";
import { startMcpServer } from "./mcp-output";
import { Outbox } from "./outbox";
import { DockerSandboxProvider } from "./sandbox/docker";

const LIBRARY_RESCAN_MS = 60_000;

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Removes containers and networks left behind by a previous runner process. */
async function reapDocker(runnerId: string): Promise<void> {
  const label = `label=orch.runner=${runnerId}`;
  try {
    const containers = await run(["docker", "ps", "-aq", "--filter", label]);
    if (containers.code !== 0) {
      console.warn(`[main] docker unavailable, skipping cleanup: ${containers.stderr.trim()}`);
      return;
    }
    const ids = containers.stdout.split("\n").filter(Boolean);
    if (ids.length) {
      console.log(`[main] removing ${ids.length} leftover container(s)`);
      await run(["docker", "rm", "-f", ...ids]);
    }
    const networks = await run(["docker", "network", "ls", "-q", "--filter", label]);
    const netIds = networks.stdout.split("\n").filter(Boolean);
    if (netIds.length) {
      console.log(`[main] removing ${netIds.length} leftover network(s)`);
      await run(["docker", "network", "rm", ...netIds]);
    }
  } catch (err) {
    console.warn(`[main] docker unavailable, skipping cleanup: ${(err as Error).message}`);
  }
}

async function ompVersion(): Promise<string> {
  try {
    const { code, stdout } = await run(["omp", "--version"]);
    if (code === 0) return stdout.trim().replace(/^omp\//, "");
  } catch {
    // omp missing: startGateway reports it
  }
  return "unknown";
}

async function main(): Promise<void> {
  let config: RunnerConfig;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`[main] ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`[main] runner ${config.runnerId} (data ${config.dataDir}, roots ${config.allowedRoots.join(", ") || "none"})`);

  await reapDocker(config.runnerId);

  let gateway: Gateway;
  try {
    gateway = await startGateway(config);
  } catch (err) {
    console.error(err instanceof PortInUseError ? err.message : `[main] gateway startup failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const mcp = await startMcpServer(config);
  const library = new Library(config.skillDirs, config.commandDirs);
  await library.scan();
  const harnessVersion = await ompVersion();

  // `conn` is assigned before any message can be sent (outbox/jobs only send after connect).
  let conn: Connection | undefined;
  const send = (msg: RunnerMessage) => conn?.send(msg);

  const outbox = new Outbox(join(config.dataDir, "outbox.sqlite"), send);
  const jobs = new JobManager({
    config,
    library,
    gateway,
    mcp,
    sandboxes: new DockerSandboxProvider(config),
    emit: (draft) => outbox.append(draft),
    send,
    rpc: <T>(method: "github.token" | "github.createPullRequest", params: unknown) => {
      if (!conn) return Promise.reject(new Error("Not connected"));
      return conn.rpc<T>(method, params);
    },
  });

  // JSON of the model list last advertised in hello, to avoid re-sending unchanged capabilities.
  let lastModelsFingerprint = JSON.stringify([]);
  const sendHello = async () => {
    const { skills, commands } = library.catalog();
    const models = await gateway.listGatewayModels([]);
    lastModelsFingerprint = JSON.stringify(models);
    send({
      t: "hello",
      protocol: WIRE_PROTOCOL,
      runnerId: config.runnerId,
      version: pkg.version,
      capabilities: {
        labels: config.labels,
        maxConcurrentJobs: config.maxConcurrentJobs,
        allowedRoots: config.allowedRoots,
        harnesses: [{ id: "omp", version: harnessVersion }],
        models,
        sandboxProviders: ["docker"],
        acceptUntrusted: config.acceptUntrusted,
        skills,
        commands,
      },
    });
  };

  const onMessage = (msg: ServerMessage) => {
    switch (msg.t) {
      case "welcome":
        for (const [runId, seq] of Object.entries(msg.lastAckedSeq)) outbox.ack(runId, seq);
        outbox.replayAll();
        return;
      case "job.assign":
        jobs.assign(msg.run);
        return;
      case "job.cancel":
        jobs.cancel(msg.runId);
        return;
      case "job.ack":
        outbox.ack(msg.runId, msg.seq);
        return;
      case "permission.respond":
        jobs.respondPermission(msg.runId, msg.requestId, msg.optionId);
        return;
      case "elicitation.respond":
        jobs.respondElicitation(msg.runId, msg.requestId, msg.action, msg.content);
        return;
      case "intervention.respond":
        jobs.respondIntervention(msg.runId, msg.requestId, msg);
        return;
      case "rpc.call":
        fsList(msg.params.path, config.allowedRoots).then(
          (result) => send({ t: "rpc.result", rpcId: msg.rpcId, ok: true, result }),
          (err) => send({ t: "rpc.result", rpcId: msg.rpcId, ok: false, error: (err as Error).message }),
        );
        return;
      default:
        return;
    }
  };

  conn = new Connection({
    url: config.serverUrl,
    token: config.token,
    onOpen: async () => {
      await library.scan();
      await sendHello();
    },
    onMessage,
  });

  outbox.start();
  conn.start();

  const rescan = setInterval(async () => {
    try {
      const changed = await library.scan();
      // The gateway's model list can change (credentials landing in the broker, models added or removed);
      // re-send hello when it differs from what the server currently holds.
      const models = await gateway.listGatewayModels([]);
      const fingerprint = JSON.stringify(models);
      if (conn?.connected && (changed || fingerprint !== lastModelsFingerprint)) {
        console.log("[main] runner capabilities changed; re-sending hello");
        await sendHello();
        lastModelsFingerprint = fingerprint;
      }
    } catch (err) {
      console.error(`[main] capability rescan failed: ${(err as Error).message}`);
    }
  }, LIBRARY_RESCAN_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.error(`[main] ${signal} again; exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`[main] ${signal}: shutting down`);
    clearInterval(rescan);
    try {
      await jobs.shutdown();
      outbox.flush();
    } catch (err) {
      console.error(`[main] job shutdown failed: ${(err as Error).message}`);
    }
    conn?.stop();
    outbox.close();
    await Promise.allSettled([mcp.stop(), gateway.stop()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await main();
