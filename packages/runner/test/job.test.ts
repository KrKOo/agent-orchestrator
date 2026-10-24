import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssignedRun,
  FlowDefinition,
  type FlowDefinitionInput,
  type GitHubTokenParams,
  type RunEventDraft,
  type RunnerMessage,
  UNTRUSTED_PREAMBLE,
} from "@orch/protocol";
import { ulid } from "ulid";
import type { RunnerConfig } from "../src/config";
import type { Gateway } from "../src/gateway";
import { PendingRequests, plainText, runJob, type JobDeps } from "../src/job";
import { Library } from "../src/library";
import type { McpOutputServer } from "../src/mcp-output";
import type { CreateSandbox, Sandbox, SandboxProvider } from "../src/sandbox/types";
import { sinkToWritable } from "../src/sandbox/types";

const FAKE_AGENT = join(import.meta.dir, "fixtures", "fake-agent.ts");

let root: string;
let repo: string;
let config: RunnerConfig;
let library: Library;
/** Stand-in for github.com: `<ghRoot>/acme/widget.git` is a bare repo with a base and a head commit. */
let ghRoot: string;
let baseSha: string;
let headSha: string;

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
  const gateway: Gateway = {
    token: "gw-token",
    listGatewayProviders: async (fallback) => fallback,
    listGatewayModels: async (fallback) => fallback,
    stop: async () => {},
  };
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
  ghRoot = join(root, "gh");
  const work = join(root, "pr-work");
  mkdirSync(work);
  const commit = (msg: string) => sh(work, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", msg);
  sh(work, "git", "init", "-q", "-b", "main");
  writeFileSync(join(work, "app.py"), "print('hi')\n");
  sh(work, "git", "add", ".");
  commit("base");
  baseSha = sh(work, "git", "rev-parse", "HEAD");
  sh(work, "git", "checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "app.py"), "print('hi')\neval(input())\n");
  commit("head");
  headSha = sh(work, "git", "rev-parse", "HEAD");
  mkdirSync(join(ghRoot, "acme"), { recursive: true });
  sh(root, "git", "clone", "-q", "--bare", work, join(ghRoot, "acme", "widget.git"));
  return library.scan();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("plainText (commit message / PR title source)", () => {
  test("unwraps one enclosing fence, with or without a language tag", () => {
    expect(plainText("```\nfeat: add hello.txt\n```")).toBe("feat: add hello.txt");
    expect(plainText("  ````text\nfix: a\n\nbody ``` inner\n````\n")).toBe("fix: a\n\nbody ``` inner");
  });

  test("leaves text with a fence in the middle untouched", () => {
    const text = "feat: x\n\n```\ncode\n```";
    expect(plainText(text)).toBe(text);
  });
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

  test("omp config maps harness model roles and gateway providers into models.yml/modelRoles", async () => {
    const sandboxes = new FakeSandboxProvider();
    const { deps } = harnessDeps(sandboxes);
    const run = assigned({
      harness: {
        id: "omp",
        model: "anthropic/claude-sonnet-4-5",
        modelRoles: { slow: "litellm/glm-5.3", plan: "litellm/deepseek" },
      },
      steps: [{ kind: "prompt", id: "hello", name: "Hello", prompt: "Say hello" }],
    });
    await runJob(run, deps, new AbortController().signal);

    const config = sandboxes.specs[0]!.files.find((f) => f.path === "omp-config.yml")!;
    expect(config.content).toBe(
      [
        "modelRoles:",
        '  slow: "litellm/glm-5.3"',
        '  plan: "litellm/deepseek"',
        '  default: "anthropic/claude-sonnet-4-5"',
        '  smol: "anthropic/claude-sonnet-4-5"',
        "tools:",
        "  approvalMode: yolo",
        "async:",
        "  enabled: false",
        "",
      ].join("\n"),
    );
    // Roles render in declaration order with `default`/`smol` appended after custom roles (Map insertion order).
    const models = sandboxes.specs[0]!.files.find((f) => f.path === "models.yml")!;
    expect(models.content).toContain('"anthropic":');
    expect(models.content).toContain('"litellm":');
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

describe("runJob: untrusted pull request runs", () => {
  const prFlow = (steps: FlowDefinitionInput["steps"]): Partial<FlowDefinitionInput> & Pick<FlowDefinitionInput, "steps"> => ({
    workspace: { kind: "github_checkout" },
    trigger: { kind: "github_pull_request", repos: ["acme/widget"] },
    steps,
  });
  const prRun = (steps: FlowDefinitionInput["steps"], trust: AssignedRun["trust"] = "untrusted"): AssignedRun => ({
    ...assigned(prFlow(steps), trust),
    github: { repo: "acme/widget", number: 7, headSha, baseSha },
  });

  test("checks out the PR head read-only with the diff in /orch/context", async () => {
    const sandboxes = new FakeSandboxProvider();
    const { deps, events, sent } = harnessDeps(sandboxes);
    deps.config = { ...config, acceptUntrusted: true };
    deps.githubGitUrl = `file://${ghRoot}`;
    const rpcCalls: { method: string; params: unknown }[] = [];
    deps.rpc = async <T>(method: string, params: unknown) => {
      rpcCalls.push({ method, params });
      return { token: "read-token" } as T;
    };
    const run = prRun([
      { kind: "prompt", id: "review", name: "Review", prompt: "read app.py and echo" },
      { kind: "prompt", id: "again", name: "Again", prompt: "echo again" },
    ]);
    await runJob(run, deps, new AbortController().signal);

    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
    const params: GitHubTokenParams = { runId: run.runId, repo: "acme/widget", access: "read" };
    expect(rpcCalls).toEqual([{ method: "github.token", params }]);

    const checkout = join(config.dataDir, "checkouts", run.runId);
    const contextDir = join(config.dataDir, "runs", run.runId, "context");
    expect(ofType(events, "run.status")[0]!.payload).toEqual({ status: "running", workspace: { path: checkout } });
    const spec = sandboxes.specs[0]!;
    expect(spec.mounts).toContainEqual({ hostPath: checkout, containerPath: checkout, readonly: true });
    expect(spec.mounts).toContainEqual({ hostPath: contextDir, containerPath: "/orch/context", readonly: true });
    // No writable mount besides the omp session dir; no user agents/skills for untrusted runs.
    expect(spec.mounts.filter((m) => !m.readonly).map((m) => m.containerPath)).toEqual(["/orch/sessions"]);
    expect(spec.mounts.some((m) => m.containerPath.startsWith("/orch/omp-user"))).toBe(false);

    const diff = readFileSync(join(contextDir, "pr.diff"), "utf8");
    expect(diff).toContain("+eval(input())");
    expect(diff).toContain("a/app.py");

    const [first, second] = ofType(events, "step.finished").map((e) => e.payload.output ?? "");
    // The agent ran in the checkout at the PR head.
    expect(first).toContain("print('hi')\neval(input())\n");
    // Only the session's first prompt carries the preamble.
    expect(first).toContain(`\n${UNTRUSTED_PREAMBLE}\n\nread app.py and echo`);
    expect(second).toContain("\necho again");
    expect(second).not.toContain(UNTRUSTED_PREAMBLE);
    // The checkout is deleted after the run.
    expect(existsSync(checkout)).toBe(false);
    expect(sandboxes.destroyed).toBe(1);
  });

  test("owner runs cannot use github_checkout", async () => {
    const { deps, sent } = harnessDeps(new FakeSandboxProvider());
    const run = prRun([{ kind: "prompt", id: "p", name: "P", prompt: "x" }], "owner");
    await runJob(run, deps, new AbortController().signal);
    expect(sent).toEqual([{ t: "job.rejected", runId: run.runId, reason: "github_checkout requires a pull request run" }]);
  });

  test("untrusted runs without pull request metadata are rejected", async () => {
    const sandboxes = new FakeSandboxProvider();
    const { deps, sent } = harnessDeps(sandboxes);
    deps.config = { ...config, acceptUntrusted: true };
    const run = assigned(prFlow([{ kind: "prompt", id: "p", name: "P", prompt: "x" }]), "untrusted");
    await runJob(run, deps, new AbortController().signal);
    expect(sent).toEqual([{ t: "job.rejected", runId: run.runId, reason: "Untrusted runs require a pull request" }]);
    expect(sandboxes.specs).toHaveLength(0);
  });

  test("untrusted runs with option-like shas are rejected", async () => {
    const { deps, sent } = harnessDeps(new FakeSandboxProvider());
    deps.config = { ...config, acceptUntrusted: true };
    const run = { ...prRun([{ kind: "prompt", id: "p", name: "P", prompt: "x" }]), github: { repo: "acme/widget", number: 7, headSha: "--upload-pack=x", baseSha } };
    await runJob(run, deps, new AbortController().signal);
    expect(sent).toEqual([{ t: "job.rejected", runId: run.runId, reason: "Invalid pull request metadata" }]);
  });
});
