import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { RunnerConfig } from "../config";
import { renderSquidConf } from "./egress";
import { type CreateSandbox, type Sandbox, type SandboxProcess, type SandboxProvider, sinkToWritable, sortMountsByDepth } from "./types";

export const EGRESS_IMAGE = "orch/egress:latest";
const READY_TIMEOUT_MS = 20_000;

interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function docker(args: string[], env?: Record<string, string>): Promise<DockerResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function dockerOk(args: string[], env?: Record<string, string>): Promise<string> {
  const res = await docker(args, env);
  if (res.code !== 0) throw new Error(`docker ${args[0]} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout.trim();
}

function assertMountPath(p: string): void {
  // `--mount` is CSV; commas and quotes would let a path inject mount options.
  if (/[,"\n]/.test(p) || !p.startsWith("/")) throw new Error(`Unsupported mount path: ${p}`);
}

/** Polls `check` until it returns true or the timeout elapses. */
async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly id = "docker" as const;

  constructor(private readonly config: RunnerConfig) {}

  async create(spec: CreateSandbox): Promise<Sandbox> {
    const { runId } = spec;
    const names = { net: `orch-net-${runId}`, egress: `orch-egress-${runId}`, run: `orch-run-${runId}` };
    const labels = ["--label", `orch.runner=${this.config.runnerId}`, "--label", `orch.run=${runId}`];
    const runDir = join(this.config.dataDir, "runs", runId);
    const configDir = join(runDir, "config");
    const sandbox = new DockerSandbox(names);
    try {
      await dockerOk(["network", "create", "--internal", ...labels, names.net]);

      // Egress proxy: default bridge for the way out, plus the run's internal network.
      await mkdir(runDir, { recursive: true });
      const squidConf = join(runDir, "squid.conf");
      await writeFile(squidConf, renderSquidConf(spec.network, this.config.ports));
      await chmod(squidConf, 0o644);
      await dockerOk([
        "run", "-d", "--name", names.egress, ...labels,
        "--add-host", "host.docker.internal:host-gateway",
        // host-gateway also maps to an IPv6 address (Docker Desktop) that squid prefers and that cannot reach
        // services bound to 127.0.0.1; IPv4-only egress keeps squid on the IPv4 route.
        "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
        "--mount", `type=bind,source=${squidConf},target=/etc/squid/orch.conf,readonly`,
        EGRESS_IMAGE,
      ]);
      await dockerOk(["network", "connect", names.net, names.egress]);

      await mkdir(configDir, { recursive: true });
      for (const file of spec.files) {
        const target = normalize(join(configDir, file.path));
        if (!target.startsWith(`${configDir}/`)) throw new Error(`Sandbox file escapes config dir: ${file.path}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
        await chmod(target, 0o644);
      }

      const mountArgs: string[] = [];
      for (const m of sortMountsByDepth(spec.mounts)) {
        assertMountPath(m.hostPath);
        assertMountPath(m.containerPath);
        mountArgs.push("--mount", `type=bind,source=${m.hostPath},target=${m.containerPath}${m.readonly ? ",readonly" : ""}`);
      }
      const proxy = `http://${names.egress}:3128`;
      // Values travel via the docker CLI's environment (`-e NAME`), keeping secrets out of argv.
      const env: Record<string, string> = {
        ...spec.env,
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        NO_PROXY: "",
        no_proxy: "",
      };
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      await dockerOk(
        [
          "run", "-d", "--name", names.run, ...labels,
          "--network", names.net,
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "1024",
          "--cpus", String(spec.cpus), "--memory", `${spec.memoryMb}m`,
          ...(this.config.dockerRuntime ? ["--runtime", this.config.dockerRuntime] : []),
          "--user", `${uid}:${gid}`,
          "-e", "HOME=/home/agent",
          "--tmpfs", "/home/agent:rw,exec,size=2g,mode=1777",
          "--tmpfs", "/tmp:rw,exec,size=2g,mode=1777",
          "--mount", `type=bind,source=${configDir},target=/orch/config,readonly`,
          ...mountArgs,
          ...Object.keys(env).flatMap((k) => ["-e", k]),
          spec.image,
          "sleep", "infinity",
        ],
        env,
      );

      await waitFor(`egress proxy ${names.egress}`, async () => {
        const logs = await docker(["logs", names.egress]);
        if (/FATAL|Bungled/.test(logs.stderr)) throw new Error(`Egress proxy failed: ${logs.stderr.trim().slice(-500)}`);
        return logs.stderr.includes("Accepting HTTP Socket connections");
      });
      // The image entrypoint prepares $HOME, then execs the CMD; wait until PID 1 is `sleep`.
      await waitFor(`sandbox ${names.run}`, async () => {
        const res = await docker(["exec", names.run, "cat", "/proc/1/cmdline"]);
        return res.code === 0 && res.stdout.startsWith("sleep\0");
      });
      return sandbox;
    } catch (err) {
      await sandbox.destroy();
      throw err;
    }
  }
}

class DockerSandbox implements Sandbox {
  private destroyed: Promise<void> | null = null;

  constructor(private readonly names: { net: string; egress: string; run: string }) {}

  exec(argv: string[], cwd: string): SandboxProcess {
    const proc = Bun.spawn(["docker", "exec", "-i", "-w", cwd, this.names.run, ...argv], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdin: sinkToWritable(proc.stdin),
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited,
      kill: () => proc.kill(),
    };
  }

  destroy(): Promise<void> {
    this.destroyed ??= (async () => {
      const rm = await docker(["rm", "-f", this.names.run, this.names.egress]);
      if (rm.code !== 0 && !/No such container/i.test(rm.stderr)) {
        console.error(`[sandbox] docker rm failed: ${rm.stderr.trim()}`);
      }
      const net = await docker(["network", "rm", this.names.net]);
      if (net.code !== 0 && !/No such network|not found/i.test(net.stderr)) {
        console.error(`[sandbox] docker network rm failed: ${net.stderr.trim()}`);
      }
    })();
    return this.destroyed;
  }
}
