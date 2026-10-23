import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssignedRun, FlowDefinition, type FlowDefinitionInput, type RunEventDraft, type RunnerMessage } from "@orch/protocol";
import { ulid } from "ulid";
import type { RunnerConfig } from "../src/config";
import type { Gateway } from "../src/gateway";
import { PendingRequests, runJob, type JobDeps } from "../src/job";
import { Library } from "../src/library";
import type { McpOutputServer } from "../src/mcp-output";
import type { CreateSandbox, Sandbox, SandboxProvider } from "../src/sandbox/types";
import { sinkToWritable } from "../src/sandbox/types";

const FAKE_AGENT = join(import.meta.dir, "fixtures", "fake-agent.ts");

let root: string;
let repo: string;
let config: RunnerConfig;
let library: Library;

function sh(cwd: string, ...argv: string[]): string {
  const res = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

/** Runs the harness argv-independent fake agent locally instead of in a container. */
class FakeSandboxProvider implements SandboxProvider {
  readonly id = "docker" as const;
  specs: CreateSandbox[] = [];
  destroyed = 0;

  async create(spec: CreateSandbox): Promise<Sandbox> {
    this.specs.push(spec);
    return {
      exec: (_argv, cwd) => {
        const proc = Bun.spawn(["bun", FAKE_AGENT], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        return {
          stdin: sinkToWritable(proc.stdin),
          stdout: proc.stdout,
          stderr: proc.stderr,
          exited: proc.exited,
          kill: () => proc.kill(),
        };
      },
      destroy: async () => {
        this.destroyed++;
      },
    };
  }
}

function harnessDeps(sandboxes: SandboxProvider) {
  const events: RunEventDraft[] = [];
  const sent: RunnerMessage[] = [];
  const gateway: Gateway = { token: "gw-token", listGatewayProviders: async (fallback) => fallback, stop: async () => {} };
  const mcp: McpOutputServer = {
    registerRun: (runId) => ({ url: `http://host.docker.internal:7802/mcp/${runId}`, secret: "secret" }),
    unregisterRun: () => {},
    stop: async () => {},
  };
  const deps: JobDeps = {
    config,
    library,
    gateway,
    mcp,
    sandboxes,
    emit: (draft) => events.push(draft),
    send: (msg) => sent.push(msg),
    rpc: () => Promise.reject(new Error("no rpc in tests")),
  };
  return { deps, events, sent };
}

function assigned(flow: Partial<FlowDefinitionInput> & Pick<FlowDefinitionInput, "steps">, trust: AssignedRun["trust"] = "owner"): AssignedRun {
  const definition = FlowDefinition.parse({
    name: "test",
    workspace: { kind: "local_path", path: repo },
    harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
    ...flow,
  });
  return { runId: ulid(), trust, definition, inputs: {} };
}

const ofType = <T extends RunEventDraft["type"]>(events: RunEventDraft[], type: T) =>
  events.filter((e): e is Extract<RunEventDraft, { type: T }> => e.type === type);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "runjob-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  sh(repo, "git", "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  const commands = join(root, "commands");
  mkdirSync(commands);
  writeFileSync(join(commands, "commit-msg.md"), "---\ndescription: commit\n---\nWrite a commit message. $ARGUMENTS\n");
  library = new Library([], [commands]);
  config = {
    serverUrl: "ws://127.0.0.1:1/runner/ws",
    token: "t",
    runnerId: "test-runner",
    labels: [],
    maxConcurrentJobs: 2,
    allowedRoots: [root],
    acceptUntrusted: false,
    dataDir: join(root, "data"),
    skillDirs: [],
    commandDirs: [commands],
    ports: { mcp: 7802, broker: 7803, gateway: 7804 },
    hostBind: "127.0.0.1",
    git: { authorName: "Orch Test", authorEmail: "orch@test" },
  };
  return library.scan();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runJob", () => {
  test("prompt step: output is the concatenated chunks", async () => {
    const sandboxes = new FakeSandboxProvider();
    const { deps, events, sent } = harnessDeps(sandboxes);
    const run = assigned({ steps: [{ kind: "prompt", id: "hello", name: "Hello", prompt: "Say hello" }] });
    await runJob(run, deps, new AbortController().signal);

    expect(sent.map((m) => m.t)).toEqual(["job.accepted", "job.finished"]);
    expect(sent[1]).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });

    const statuses = ofType(events, "run.status").map((e) => e.payload);
    expect(statuses.map((s) => s.status)).toEqual(["running", "succeeded"]);
    const branch = `orch/${run.runId.slice(0, 10).toLowerCase()}`;
    expect(statuses[0]!.workspace).toEqual({ path: join(config.dataDir, "worktrees", run.runId), branch });

    const updates = ofType(events, "acp.update").map((e) => e.payload.update.sessionUpdate);
    expect(updates.filter((u) => u === "agent_message_chunk")).toHaveLength(3);
    expect(updates).toContain("tool_call");
    expect(ofType(events, "step.started").map((e) => e.stepId)).toEqual(["hello"]);
    const finished = ofType(events, "step.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.stepId).toBe("hello");
    expect(finished[0]!.payload).toEqual({ status: "succeeded", output: "Hello, world" });

    // Sandbox spec: worktree + .git mounts with ro overlays, omp config files, gateway env.
    const spec = sandboxes.specs[0]!;
    const gitDir = join(repo, ".git");
    expect(spec.mounts).toContainEqual({ hostPath: gitDir, containerPath: gitDir, readonly: false });
    expect(spec.mounts).toContainEqual({ hostPath: join(gitDir, "hooks"), containerPath: join(gitDir, "hooks"), readonly: true });
    expect(spec.mounts).toContainEqual({ hostPath: join(gitDir, "config"), containerPath: join(gitDir, "config"), readonly: true });
    expect(spec.files.map((f) => f.path).sort()).toEqual(["models.yml", "omp-config.yml"]);
    expect(spec.env).toEqual({ ORCH_GATEWAY_TOKEN: "gw-token" });
    expect(sandboxes.destroyed).toBe(1);
    // The user's checkout is untouched.
    expect(sh(repo, "git", "status", "--porcelain")).toBe("");
    expect(sh(repo, "git", "branch", "--show-current")).toBe("main");
  });

  test("command + git_commit commit agent changes in the worktree", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const run = assigned({
      steps: [
        { kind: "prompt", id: "impl", name: "Implement", prompt: "write hello.txt" },
        { kind: "command", id: "msg", name: "Message", command: "commit-msg" },
        { kind: "git_commit", id: "commit", name: "Commit", messageFrom: "msg" },
      ],
    });
    await runJob(run, deps, new AbortController().signal);

    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
    const finished = ofType(events, "step.finished");
    expect(finished.map((e) => e.payload.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    const worktree = join(config.dataDir, "worktrees", run.runId);
    expect(finished[2]!.payload.output).toBe(sh(worktree, "git", "rev-parse", "HEAD"));
    expect(sh(worktree, "git", "log", "-1", "--format=%s|%an")).toBe("Hello, world|Orch Test");
    expect(sh(worktree, "git", "show", "--name-only", "--format=", "HEAD")).toBe("hello.txt");
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
  });

  test("approval ask: permission request round-trips through PendingRequests", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const pending = new PendingRequests();
    deps.emit = (draft) => {
      events.push(draft);
      if (draft.type === "acp.permission_request") queueMicrotask(() => pending.settle(draft.payload.requestId, { optionId: "allow" }));
    };
    const run = assigned({ approval: "ask", steps: [{ kind: "prompt", id: "p", name: "P", prompt: "ask first" }] });
    await runJob(run, deps, new AbortController().signal, pending);

    expect(sent.at(-1)).toMatchObject({ t: "job.finished", status: "succeeded" });
    const req = ofType(events, "acp.permission_request")[0]!;
    expect(req.stepId).toBe("p");
    expect(req.payload.options.map((o) => o.optionId)).toEqual(["allow", "reject"]);
    expect(ofType(events, "acp.permission_resolved")[0]!.payload).toEqual({ requestId: req.payload.requestId, optionId: "allow" });
    // Text after the permission-gated tool call starts a new paragraph.
    expect(ofType(events, "step.finished")[0]!.payload.output).toBe("Hello, world\n\n allow");
  });

  test("cancel ends the step and the run cancelled", async () => {
    const sandboxes = new FakeSandboxProvider();
    const { deps, events, sent } = harnessDeps(sandboxes);
    const abort = new AbortController();
    deps.emit = (draft) => {
      events.push(draft);
      if (draft.type === "acp.update") queueMicrotask(() => abort.abort());
    };
    const run = assigned({ steps: [{ kind: "prompt", id: "slow", name: "Slow", prompt: "count slow" }] });
    await runJob(run, deps, abort.signal);

    expect(ofType(events, "step.finished")[0]!.payload.status).toBe("cancelled");
    expect(ofType(events, "run.status").at(-1)!.payload.status).toBe("cancelled");
    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "cancelled" });
    expect(ofType(events, "sandbox.log").map((e) => e.payload.text)).toContain("fake-agent: waiting for cancel");
    expect(sandboxes.destroyed).toBe(1);
  });

  test("untrusted local_path runs are rejected", async () => {
    const sandboxes = new FakeSandboxProvider();
    const { deps, events, sent } = harnessDeps(sandboxes);
    deps.config = { ...config, acceptUntrusted: true };
    const run = assigned({ steps: [{ kind: "prompt", id: "p", name: "P", prompt: "x" }] }, "untrusted");
    await runJob(run, deps, new AbortController().signal);
    expect(sent).toEqual([{ t: "job.rejected", runId: run.runId, reason: "Untrusted runs cannot mount local paths" }]);
    expect(events).toEqual([]);
    expect(sandboxes.specs).toHaveLength(0);
  });

  test("workspace outside allowedRoots is rejected", async () => {
    const { deps, sent } = harnessDeps(new FakeSandboxProvider());
    const run = assigned({ workspace: { kind: "local_path", path: tmpdir() }, steps: [{ kind: "prompt", id: "p", name: "P", prompt: "x" }] });
    await runJob(run, deps, new AbortController().signal);
    expect(sent).toEqual([{ t: "job.rejected", runId: run.runId, reason: "Path outside allowedRoots" }]);
  });
});
