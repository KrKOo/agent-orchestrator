import { afterAll, beforeAll, describe, expect, test, vi } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssignedRun,
  FlowDefinition,
  type CreateCommentParams,
  type FlowDefinitionInput,
  type GitHubTokenParams,
  type RunEventDraft,
  type RunnerMessage,
  UNTRUSTED_PREAMBLE,
  TERMINAL_STATUSES,
  type SessionUpdate,
} from "@orch/protocol";
import { ulid } from "ulid";
import type { RunnerConfig } from "../src/config";
import type { Gateway } from "../src/gateway";
import { JobManager, PendingRequests, plainText, runJob, type JobDeps } from "../src/job";
import { Library } from "../src/library";
import { type McpOutputServer, startMcpServer } from "../src/mcp-output";
import type { CreateSandbox, Sandbox, SandboxProvider } from "../src/sandbox/types";
import { sinkToWritable } from "../src/sandbox/types";

const FAKE_AGENT = join(import.meta.dir, "fixtures", "fake-agent.ts");
/** Print-mode responder for slash steps: echoes the prompt text on stdout. */
const FAKE_PRINT = join(import.meta.dir, "fixtures", "fake-print.ts");

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
      exec: (argv, cwd) => {
        // `omp -p ...` (slash steps): run the fake print-mode responder instead of the ACP agent.
        if (argv.includes("-p")) {
          const resume = argv.indexOf("--resume");
          const args = [argv[argv.indexOf("--") + 1] ?? "", resume >= 0 ? argv[resume + 1]! : ""];
          const proc = Bun.spawn(["bun", FAKE_PRINT, ...args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
          return {
            stdin: sinkToWritable(proc.stdin),
            stdout: proc.stdout,
            stderr: proc.stderr,
            exited: proc.exited,
            kill: () => proc.kill(),
          };
        }
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
    registerRun: (runId) => ({ url: `http://host.docker.internal:7804/mcp/${runId}`, secret: "secret" }),
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
    seedOutbox: () => {},
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
  // The worktree repo gets a GitHub-shaped origin (parsed by `parseGitHubRemote`) so action steps
  // (git_push/github_pr) see `repo`; this test never fetches or pushes through it.
  sh(repo, "git", "remote", "add", "origin", "https://github.com/acme/widget.git");
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
    expect(statuses[0]!.workspace).toEqual({ path: join(config.dataDir, "worktrees", run.runId), branch, repo: "acme/widget" });

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
    expect(models.content).toBe(
      [
        "providers:",
        '  "anthropic":',
        '    baseUrl: "http://host.docker.internal:7804"',
        "    apiKey: ORCH_GATEWAY_TOKEN",
        "    transport: pi-native",
        '    api: "anthropic-messages"',
        "    models:",
        '      - id: "claude-sonnet-4-5"',
        '        name: "claude-sonnet-4-5"',
        '  "litellm":',
        '    baseUrl: "http://host.docker.internal:7804"',
        "    apiKey: ORCH_GATEWAY_TOKEN",
        "    transport: pi-native",
        '    api: "openai-completions"',
        "    models:",
        '      - id: "glm-5.3"',
        '        name: "glm-5.3"',
        '      - id: "deepseek"',
        '        name: "deepseek"',
        "",
      ].join("\n"),
    );
  });

  test("slash step runs omp -p with the command, streams events, and outputs the final text", async () => {
    const provider = new FakeSandboxProvider();
    const { deps, events, sent } = harnessDeps(provider);
    const run = assigned({
      inputs: [{ key: "topic", label: "Topic", type: "text", required: true }],
      steps: [{ kind: "slash", id: "review", name: "Review", command: "review", args: "focus on {{inputs.topic}}" }],
    });
    run.inputs.topic = "tea";
    await runJob(run, deps, new AbortController().signal);

    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
    const started = ofType(events, "step.started");
    expect(started.map((e) => e.stepId)).toEqual(["review"]);
    const finished = ofType(events, "step.finished");
    expect(finished[0]!.payload.status).toBe("succeeded");
    expect(finished[0]!.payload.output).toBe("print:/review focus on tea\n");
    // Assistant text streamed as acp.update chunks.
    const updates = ofType(events, "acp.update").filter((e) => e.stepId === "review");
    const chunkText = (u: SessionUpdate): string => {
      if (u.sessionUpdate !== "agent_message_chunk") return "";
      const c: unknown = u.content;
      if (typeof c !== "object" || c === null || !("text" in c) || typeof c.text !== "string") return "";
      return c.text;
    };
    expect(updates.map((e) => chunkText(e.payload.update)).join("")).toBe("print:/review focus on tea\n");
    // Raw NDJSON still lands in the sandbox log.
    const logs = ofType(events, "sandbox.log").filter((e) => e.stepId === "review");
    expect(logs.map((e) => e.payload.text).join("")).toContain("message_update");
  });

  describe("structured output (submit_output)", () => {
    let mcpPort = 7810;
    /** Real per-run MCP endpoint; `getSpec` wired like `runJob` does. */
    const withRealMcp = async (deps: JobDeps): Promise<McpOutputServer> => {
      deps.config = { ...config, ports: { ...config.ports, mcp: mcpPort++ } };
      return await startMcpServer(deps.config);
    };

    test("declared fields: prompt asks for submit_output, submitted object lands in step.finished and later templates", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      deps.mcp = await withRealMcp(deps);
      const run = assigned({
        steps: [
          {
            kind: "prompt",
            id: "gen",
            name: "Gen",
            // `echo` makes the fake agent stream the full prompt back, instruction block included;
            // the submit regex still captures only the trailing JSON object.
            prompt: `echo submit {"title":"My PR","score":7}`,
            structured: {
              fields: [
                { name: "title", description: "PR title" },
                { name: "score", description: "Score" },
              ],
            },
          },
          { kind: "prompt", id: "use", name: "Use", prompt: "echo title={{steps.gen.structured.title}} score={{steps.gen.structured.score}}" },
        ],
      });
      try {
        await runJob(run, deps, new AbortController().signal);

        expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
        const [gen, use] = ofType(events, "step.finished");
        expect(gen!.payload.structured).toEqual({ title: "My PR", score: 7 });
        // The fake agent echoes the full prompt: the submit_output instruction block was appended.
        const genText = ofType(events, "acp.update")
          .filter((e) => e.stepId === "gen")
          .map((e) => e.payload.update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => {
            const c: unknown = u.content;
            return typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "";
          })
          .join("");
        expect(genText).toContain("call the submit_output tool once with a JSON object containing these fields:");
        expect(genText).toContain("- title: PR title");
        expect(genText).toContain("- score: Score");
        expect(use!.payload.output).toContain("title=My PR score=7");
      } finally {
        await deps.mcp.stop();
      }
    });

    test("missing field: the tool error is streamed to the agent, which retries with the fixed object", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      deps.mcp = await withRealMcp(deps);
      const run = assigned({
        steps: [
          {
            kind: "prompt",
            id: "gen",
            name: "Gen",
            prompt: `submit retry {"title":"Fixed","body":"Body"}`,
            structured: {
              fields: [
                { name: "title", description: "PR title" },
                { name: "body", description: "PR body" },
              ],
            },
          },
        ],
      });
      try {
        await runJob(run, deps, new AbortController().signal);

        expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
        const finished = ofType(events, "step.finished")[0]!;
        expect(finished.payload.structured).toEqual({ title: "Fixed", body: "Body" });
        // The agent saw the tool error naming the missing field, then the ok from the retry.
        const chunks = ofType(events, "acp.update").filter((e) => e.stepId === "gen").map((e) => e.payload.update);
        const texts = chunks
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => {
            const c: unknown = u.content;
            return typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "";
          });
        const all = texts.join("");
        // With a spec the MCP schema also rejects the call before the sink; the retry then succeeds.
        expect(all).toContain("error: MCP error -32602: Input validation error: Invalid arguments for tool submit_output: Invalid input: expected nonoptional, received undefined at output.body");
        expect(all).toContain("ok: ok");
      } finally {
        await deps.mcp.stop();
      }
    });

    test("never submitting: the step fails with an explicit submit_output error", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      deps.mcp = await withRealMcp(deps);
      const run = assigned({
        steps: [
          { kind: "prompt", id: "gen", name: "Gen", prompt: "hi", structured: { fields: [{ name: "title", description: "PR title" }] } },
        ],
      });
      try {
        await runJob(run, deps, new AbortController().signal);

        expect(sent.at(-1)).toEqual({
          t: "job.finished",
          runId: run.runId,
          status: "failed",
          error: "Step finished without calling submit_output: it must submit a JSON object with at least these fields: title.",
        });
        const finished = ofType(events, "step.finished")[0]!;
        expect(finished.payload.status).toBe("failed");
        expect(finished.payload.error).toBe(
          "Step finished without calling submit_output: it must submit a JSON object with at least these fields: title.",
        );
      } finally {
        await deps.mcp.stop();
      }
    });

    test("github_pr titleFrom/bodyFrom accept <step>.structured.<field> refs", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      deps.mcp = await withRealMcp(deps);
      const rpcCalls: { method: string; params: unknown }[] = [];
      deps.rpc = async <T>(method: string, params: unknown) => {
        rpcCalls.push({ method, params });
        return (method === "github.createPullRequest" ? { url: "https://github.com/acme/widget/pull/5" } : { token: "write-token" }) as T;
      };
      // The push already happened in attempt 1 (resume past it; a real push would hit github.com).
      const run = withWorktree(
        resumed(
          {
            steps: [
              { kind: "prompt", id: "done", name: "Done", prompt: "earlier" },
              { kind: "git_push", id: "push", name: "Push" },
              { kind: "prompt", id: "gen", name: "Gen", prompt: `submit {"title":"Structured title","body":"Structured\\nbody"}` },
              { kind: "github_pr", id: "pr", name: "PR", titleFrom: "gen.structured.title", bodyFrom: "gen.structured.body" },
            ],
          },
          "gen",
          ["push"],
        ),
      );
      // Attempt 1's push was skipped here; derive `pushed` the same way the runner does.
      run.resume!.prior = [
        { stepId: "done", output: "prior-output" },
        { stepId: "push", output: "pushed" },
      ];
      try {
        await runJob(run, deps, new AbortController().signal);

        expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
        const call = rpcCalls.find((c) => c.method === "github.createPullRequest");
        expect(call).toMatchObject({
          method: "github.createPullRequest",
          params: { title: "Structured title", body: "Structured\nbody" },
        });
      } finally {
        await deps.mcp.stop();
      }
    });

    test("field names are matched with Object.hasOwn, not the prototype chain", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      deps.mcp = await withRealMcp(deps);
      const run = assigned({
        steps: [
          {
            kind: "prompt",
            id: "gen",
            name: "Gen",
            // First submit {} (inherits "constructor" from Object.prototype); the runner-side check
            // must reject it via Object.hasOwn, the agent retries with an own property.
            prompt: `submit-empty {} submit {"constructor":"C"}`,
            structured: { fields: [{ name: "constructor", description: "ctor" }] },
          },
        ],
      });
      try {
        await runJob(run, deps, new AbortController().signal);

        expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
        const chunks = ofType(events, "acp.update")
          .filter((e) => e.stepId === "gen")
          .map((e) => e.payload.update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => {
            const c: unknown = u.content;
            return typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "";
          })
          .join("");
        expect(chunks).toContain("error: Missing structured field: constructor (ctor)");
        const finished = ofType(events, "step.finished")[0]!;
        expect(finished.payload.structured).toEqual({ constructor: "C" });
      } finally {
        await deps.mcp.stop();
      }
    });

    test("resume replays structured into later templates", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      const run = withWorktree(
        resumed(
          {
            steps: [
              { kind: "prompt", id: "done", name: "Done", prompt: "earlier" },
              { kind: "prompt", id: "use", name: "Use", prompt: "echo n={{steps.done.structured.n}}" },
            ],
          },
          "use",
        ),
      );
      await runJob(run, deps, new AbortController().signal);

      expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
      expect(ofType(events, "step.started").map((e) => e.stepId)).toEqual(["use"]);
      expect(ofType(events, "step.finished")[0]!.payload.output).toContain("n=1");
    });

    test("tools/list during a spec'd step carries the field schema (per-request getSpec)", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      deps.mcp = await withRealMcp(deps);
      const run = assigned({
        steps: [
          { kind: "prompt", id: "plain", name: "Plain", prompt: `echo probe` },
          {
            kind: "prompt",
            id: "gen",
            name: "Gen",
            // `probe` makes the fake agent call tools/list before submitting (see fake-agent.ts).
            prompt: `probe submit {"title":"T"}`,
            structured: { fields: [{ name: "title", description: "PR title" }] },
          },
        ],
      });
      try {
        await runJob(run, deps, new AbortController().signal);

        expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
        // The fake agent streamed the tools/list result as a chunk while the step was active.
        const genText = ofType(events, "acp.update")
          .filter((e) => e.stepId === "gen")
          .map((e) => e.payload.update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => {
            const c: unknown = u.content;
            return typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "";
          })
          .join("");
        const probe = genText.split("\nprobe: ")[1] ?? "";
        // The schema was built from the spec: field name, required, and the structured description.
        expect(probe).toContain('"title"');
        expect(probe).toContain('"required":["title"]');
        expect(probe).toContain("submit_output");
      } finally {
        await deps.mcp.stop();
      }
    });

    test("submit_output rejects non-object payloads; the agent retries and extras are kept", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      deps.mcp = await withRealMcp(deps);
      const run = assigned({
        steps: [
          {
            kind: "prompt",
            id: "gen",
            name: "Gen",
            // First two calls send an array and null (both rejected); the third submits the real object
            // with an extra key, which is accepted and preserved.
            prompt: `submit-array [1,2] submit-null null submit {"title":"T","extra":1}`,
            structured: { fields: [{ name: "title", description: "PR title" }] },
          },
        ],
      });
      try {
        await runJob(run, deps, new AbortController().signal);

        expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
        const chunks = ofType(events, "acp.update")
          .filter((e) => e.stepId === "gen")
          .map((e) => e.payload.update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => {
            const c: unknown = u.content;
            return typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "";
          })
          .join("");
        // Non-objects are rejected by the tool schema before the sink even sees them.
        expect(chunks).toContain("error: MCP error -32602: Input validation error: Invalid arguments for tool submit_output: Invalid input: expected object, received array at output");
        expect(chunks).toContain("error: MCP error -32602: Input validation error: Invalid arguments for tool submit_output: Invalid input: expected object, received null at output");
        // The extra key survives into the step result.
        const finished = ofType(events, "step.finished")[0]!;
        expect(finished.payload.structured).toEqual({ title: "T", extra: 1 });
      } finally {
        await deps.mcp.stop();
      }
    });

    test("github_comment bodyFrom accepts <step>.structured.<field> refs", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      deps.mcp = await withRealMcp(deps);
      const rpcCalls: { method: string; params: unknown }[] = [];
      deps.rpc = async <T>(method: string, params: unknown) => {
        rpcCalls.push({ method, params });
        return { url: "https://github.com/acme/widget/issues/3#issuecomment-9" } as T;
      };
      const run = assigned({
        inputs: [{ key: "issue", label: "Issue", type: "github_issue", required: true }],
        steps: [
          {
            kind: "prompt",
            id: "gen",
            name: "Gen",
            prompt: `submit {"body":"Structured\\ncomment"}`,
            structured: { fields: [{ name: "body", description: "Comment body" }] },
          },
          { kind: "github_comment", id: "post", name: "Post", target: "issue", bodyFrom: "gen.structured.body" },
        ],
      });
      run.inputs.issue = { url: "https://github.com/acme/widget/issues/3", repo: "acme/widget", number: 3, title: "Bug", body: "Broken" };
      try {
        await runJob(run, deps, new AbortController().signal);

        expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
        expect(rpcCalls.filter((c) => c.method === "github.createComment")).toEqual([
          { method: "github.createComment", params: { runId: run.runId, stepId: "post", body: "Structured\ncomment" } },
        ]);
      } finally {
        await deps.mcp.stop();
      }
    });

    test("resume with structured: null resolves stepTemplates and *From refs without crashing", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      const run = withWorktree(
        resumed(
          {
            steps: [
              { kind: "prompt", id: "done", name: "Done", prompt: "earlier" },
              { kind: "git_commit", id: "commit", name: "Commit", messageFrom: "done.structured.nope" },
            ],
          },
          "commit",
        ),
      );
      run.resume!.prior = [{ stepId: "done", output: "prior-output", structured: null }];
      await runJob(run, deps, new AbortController().signal);

      // A structured ref to a field the resume data lacks resolves to "" and fails the commit with
      // the explicit empty-message error instead of crashing.
      expect(sent.at(-1)).toEqual({
        t: "job.finished",
        runId: run.runId,
        status: "failed",
        error: "Commit message from step done.structured.nope is empty",
      });
      expect(ofType(events, "step.finished").at(-1)!.payload.status).toBe("failed");
    });
  });

  test("slash step tool activity streams as tool_call cards", async () => {
    const { deps, events } = harnessDeps(new FakeSandboxProvider());
    const run = assigned({ steps: [{ kind: "slash", id: "tools", name: "Tools", command: "plan", args: "use the tool" }] });
    await runJob(run, deps, new AbortController().signal);

    const updates = ofType(events, "acp.update").filter((e) => e.stepId === "tools").map((e) => e.payload.update);
    const started = updates.filter((u) => u.sessionUpdate === "tool_call");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ toolCallId: "tool_1", title: "Running echo", name: "bash", status: "in_progress" });
    const ended = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed");
    expect(ended).toHaveLength(1);
    expect(ended[0]!.content).toEqual([{ type: "text", text: "hi\n" }]);
  });

  test("slash step thinking streams as collapsible thought sections", async () => {
    const { deps, events } = harnessDeps(new FakeSandboxProvider());
    const run = assigned({ steps: [{ kind: "slash", id: "thinker", name: "Thinker", command: "plan", args: "think hard" }] });
    await runJob(run, deps, new AbortController().signal);

    const updates = ofType(events, "acp.update").filter((e) => e.stepId === "thinker").map((e) => e.payload.update);
    const thoughts = updates.filter((u) => u.sessionUpdate === "agent_thought_chunk");
    expect(thoughts).toHaveLength(2);
    const thoughtText = (u: SessionUpdate): string => {
      const c: unknown = u.content;
      if (typeof c !== "object" || c === null || !("text" in c) || typeof c.text !== "string") return "";
      return c.text;
    };
    expect(thoughts.map(thoughtText).join("")).toBe("pondering the request");
  });

  test("slash step failure surfaces a non-zero exit as a failed step", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const run = assigned({
      steps: [{ kind: "slash", id: "broken", name: "Broken", command: "review", args: "make it fail" }],
    });
    await runJob(run, deps, new AbortController().signal);

    expect(sent.at(-1)).toEqual({
      t: "job.finished",
      runId: run.runId,
      status: "failed",
      error: expect.stringContaining("exited with code 3"),
    });
    const finished = ofType(events, "step.finished");
    expect(finished.map((e) => e.payload.status)).toEqual(["failed"]);
    expect(finished[0]!.payload.error).toContain("exited with code 3");
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

  test("command step with structured output: no submit fails the step with the explicit error", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const run = assigned({
      steps: [
        { kind: "prompt", id: "impl", name: "Implement", prompt: "write hello.txt" },
        // The commit-msg command body renders $ARGUMENTS; the spec appends the submit instruction
        // like for prompt steps. The fake agent never calls submit_output, so the step must fail
        // with the explicit no-submit error naming the declared field.
        { kind: "command", id: "msg", name: "Message", command: "commit-msg", structured: { fields: [{ name: "message", description: "Commit message" }] }, args: "one word" },
        { kind: "git_commit", id: "commit", name: "Commit", messageFrom: "msg.structured.message" },
      ],
    });
    await runJob(run, deps, new AbortController().signal);

    expect(sent.at(-1)).toMatchObject({ t: "job.finished", status: "failed" });
    expect(ofType(events, "step.finished").at(-1)!.payload.error).toContain(
      "Step finished without calling submit_output: it must submit a JSON object with at least these fields: message.",
    );
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

  /** Answers each intervention request in order with the next scripted answer. */
  function scriptedGate(deps: JobDeps, events: RunEventDraft[], answers: Parameters<PendingRequests["settle"]>[1][]): PendingRequests {
    const pending = new PendingRequests();
    deps.emit = (draft) => {
      events.push(draft);
      if (draft.type === "intervention.request") {
        const answer = answers.shift() ?? null;
        queueMicrotask(() => pending.settle(draft.payload.requestId, answer));
      }
    };
    return pending;
  }

  test("intervention chat: a message goes verbatim into the agent session; continue passes its latest reply on", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const pending = scriptedGate(deps, events, [{ action: "message", session: "agent", text: "echo tweak it" }, { action: "continue" }]);
    const run = assigned({
      steps: [
        { kind: "prompt", id: "impl", name: "Implement", prompt: "write hello.txt" },
        { kind: "intervention", id: "gate", name: "Gate", message: "Review the change" },
        { kind: "prompt", id: "after", name: "After", prompt: "echo {{steps.gate.output}}" },
      ],
    });
    await runJob(run, deps, new AbortController().signal, pending);

    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
    const [first, second] = ofType(events, "intervention.request");
    expect(first!.payload).toEqual({
      requestId: first!.payload.requestId,
      message: "Review the change",
      sessions: [{ id: "agent", label: "Agent session (last step: Implement)", output: "Hello, world" }],
      session: "agent",
    });
    // The agent got exactly the user's text (the fake echoes prompts containing "echo").
    const reply = second!.payload.sessions[0]!.output;
    expect(reply).toMatch(/^Hello, world\n+echo tweak it$/);
    expect(ofType(events, "intervention.resolved").map((e) => e.payload.action)).toEqual(["message", "continue"]);
    // The run waits for the user at each request and is running again while the agent replies.
    expect(ofType(events, "run.status").map((e) => e.payload.status)).toEqual([
      "running",
      "awaiting_input",
      "running",
      "awaiting_input",
      "running",
      "succeeded",
    ]);
    // The message shows as a user bubble in the gate's transcript, followed by the streamed reply.
    const gateUpdates = ofType(events, "acp.update").filter((e) => e.stepId === "gate").map((e) => e.payload.update.sessionUpdate);
    expect(gateUpdates[0]).toBe("user_message_chunk");
    expect(gateUpdates).toContain("agent_message_chunk");

    const finished = Object.fromEntries(ofType(events, "step.finished").map((e) => [e.stepId, e.payload]));
    expect(finished.gate).toMatchObject({ status: "succeeded", output: reply });
    expect(finished.after!.output).toContain("echo tweak it");
  });

  test("intervention chat: slash sessions resume their omp session; continue uses the chosen session", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const pending = scriptedGate(deps, events, [
      { action: "message", session: "slash:plan", text: "add tests" },
      { action: "continue", session: "slash:plan" },
    ]);
    const run = assigned({
      steps: [
        { kind: "slash", id: "plan", name: "Plan", command: "plan", args: "an app" },
        { kind: "prompt", id: "impl", name: "Implement", prompt: "hi" },
        { kind: "intervention", id: "gate", name: "Gate" },
      ],
    });
    await runJob(run, deps, new AbortController().signal, pending);

    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
    const [first, second] = ofType(events, "intervention.request");
    expect(first!.payload.sessions).toEqual([
      { id: "slash:plan", label: "/plan (Plan)", output: "print:/plan an app\n" },
      { id: "agent", label: "Agent session (last step: Implement)", output: "Hello, world" },
    ]);
    // The previous step's session is preselected; after a message, the one chatted with.
    expect(first!.payload.session).toBe("agent");
    expect(second!.payload.session).toBe("slash:plan");
    const finished = Object.fromEntries(ofType(events, "step.finished").map((e) => [e.stepId, e.payload]));
    expect(finished.gate).toMatchObject({ status: "succeeded", output: "print:(resumed fake) add tests\n" });
  });

  test("intervention chat: unknown sessions and failed turns ask again with the error and keep the last result", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const pending = scriptedGate(deps, events, [
      { action: "message", session: "nope", text: "hi" },
      { action: "message", session: "slash:plan", text: "make it fail" },
      { action: "continue" },
    ]);
    const run = assigned({
      steps: [
        { kind: "slash", id: "plan", name: "Plan", command: "plan" },
        { kind: "intervention", id: "gate", name: "Gate" },
      ],
    });
    await runJob(run, deps, new AbortController().signal, pending);

    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
    const requests = ofType(events, "intervention.request").map((e) => e.payload);
    expect(requests.map((r) => r.error)).toEqual([undefined, 'Unknown session "nope".', "omp -p exited with code 3: boom"]);
    expect(requests[2]!.sessions).toEqual(requests[0]!.sessions);
    expect(ofType(events, "step.finished").at(-1)!.payload).toMatchObject({ status: "succeeded", output: "print:/plan\n" });
  });

  test("intervention gate: cancel while waiting cancels the step and the run", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const pending = new PendingRequests();
    const abort = new AbortController();
    deps.emit = (draft) => {
      events.push(draft);
      if (draft.type === "intervention.request") queueMicrotask(() => abort.abort());
    };
    const run = assigned({ steps: [{ kind: "intervention", id: "gate", name: "Gate" }] });
    await runJob(run, deps, abort.signal, pending);

    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "cancelled" });
    expect(ofType(events, "step.finished")[0]!.payload.status).toBe("cancelled");
    // run.status may only record "running"; the final status event is emitted after the loop.
    expect(ofType(events, "run.status").at(-1)!.payload.status).toBe("cancelled");
    // No harness was created for the intervention-only flow.
    expect(ofType(events, "acp.update")).toHaveLength(0);
  });

  test("intervention gate: timeoutSec expires into a failed step", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const run = assigned({ steps: [{ kind: "intervention", id: "gate", name: "Gate", timeoutSec: 1 }] });
    await runJob(run, deps, new AbortController().signal);

    expect(sent.at(-1)).toMatchObject({ t: "job.finished", runId: run.runId, status: "failed" });
    const finished = ofType(events, "step.finished")[0]!;
    expect(finished.stepId).toBe("gate");
    expect(finished.payload.status).toBe("failed");
    expect(finished.payload.error).toBe("No answer within 1s");
    // The timeout nulls the answer: the gate is recorded as cancelled.
    expect(ofType(events, "intervention.resolved")[0]!.payload.action).toBe("cancel");
  });

  test("intervention gate: timeoutSec 0 waits forever for an answer", async () => {
    vi.useFakeTimers();
    try {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      const pending = new PendingRequests();
      deps.emit = (draft) => {
        events.push(draft);
        if (draft.type === "intervention.request") {
          // Advance the clock past the 30-min permission cap (ANSWER_TIMEOUT_MS) before answering:
          // a wrongly-armed timer — the step cap or a `wait` fallback — fires here and nulls the
          // answer; only then is the real answer delivered.
          queueMicrotask(() => {
            vi.advanceTimersByTime(1_800_001);
            pending.settle(draft.payload.requestId, { action: "continue" });
          });
        }
      };
      const run = assigned({ steps: [{ kind: "intervention", id: "gate", name: "Gate", timeoutSec: 0 }] });
      await runJob(run, deps, new AbortController().signal, pending);

      expect(sent.at(-1)).toMatchObject({ t: "job.finished", runId: run.runId, status: "succeeded" });
      expect(ofType(events, "step.finished")[0]!.payload.status).toBe("succeeded");
    } finally {
      vi.useRealTimers();
    }
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

  test("prompt step with timeoutSec 0 never times out", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    // A wrongly-armed watchdog would abort at ~0ms, long before the fake agent's first reply;
    // with 0 the step must complete normally.
    const run = assigned({ steps: [{ kind: "prompt", id: "p", name: "P", prompt: "hi", timeoutSec: 0 }] });
    await runJob(run, deps, new AbortController().signal);

    expect(ofType(events, "step.finished")[0]!.payload.status).toBe("succeeded");
    expect(sent.at(-1)).toMatchObject({ t: "job.finished", runId: run.runId, status: "succeeded" });
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

  /** A run assigned for attempt 2: step `done` succeeded in attempt 1, `fromStepId` failed. */
  const resumed = (
    flow: Partial<FlowDefinitionInput> & Pick<FlowDefinitionInput, "steps">,
    fromStepId: string,
    /** Extra succeeded prior steps besides `done` (e.g. a skipped `git_push`). */
    priorIds: string[] = [],
  ): AssignedRun => {
    const run = assigned(flow);
    const idx = run.definition.steps.findIndex((s) => s.id === fromStepId);
    run.resume = {
      fromStepIdx: idx,
      prior: [{ stepId: "done", output: "prior-output", structured: { n: 1 } }, ...priorIds.map((stepId) => ({ stepId, output: stepId }))]
        .filter((p) => run.definition.steps.some((s) => s.id === p.stepId) && p.stepId !== fromStepId),
    };
    run.seqFrom = 9;
    return run;
  };
  /** Creates the worktree attempt 1 would have left, which a mid-run (`fromStepIdx > 0`) resume requires. */
  const withWorktree = (run: AssignedRun): AssignedRun => {
    const branch = `orch/${run.runId.slice(0, 10).toLowerCase()}`;
    sh(repo, "git", "worktree", "add", "-q", "-b", branch, join(config.dataDir, "worktrees", run.runId), "HEAD");
    return run;
  };

  describe("resumed runs", () => {
    test("renders prior step outputs in templates and starts at the cursor", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      const run = withWorktree(
        resumed(
          {
            steps: [
              { kind: "prompt", id: "done", name: "Done", prompt: "earlier" },
              { kind: "prompt", id: "fix", name: "Fix", prompt: "echo redo using {{steps.done.output}}" },
            ],
          },
          "fix",
        ),
      );
      await runJob(run, deps, new AbortController().signal);

      expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
      // The earlier step never executes: only the cursor's step runs.
      expect(ofType(events, "step.started").map((e) => e.stepId)).toEqual(["fix"]);
      // `{{steps.done.output}}` renders the persisted output instead of throwing.
      const output = ofType(events, "step.finished")[0]!.payload.output;
      expect(output).toContain("redo using prior-output");
    });

    test("emits with seqs at or above seqFrom", async () => {
      // `seqFrom` seeds the outbox in JobManager.assign; runJob only sees the event stream through
      // `emit`, so assert the seed wiring with a fake outbox instead of draft events (no seqs yet).
      const seeded: Array<[string, number]> = [];
      const { deps, sent } = harnessDeps(new FakeSandboxProvider());
      deps.seedOutbox = (runId, seqFrom) => seeded.push([runId, seqFrom]);
      const finished = Promise.withResolvers<void>();
      const emit = deps.emit;
      deps.emit = (draft) => {
        emit(draft);
        if (draft.type === "run.status" && TERMINAL_STATUSES.includes(draft.payload.status)) finished.resolve();
      };
      const manager = new JobManager(deps);
      const run = resumed({ steps: [{ kind: "prompt", id: "fix", name: "Fix", prompt: "x" }] }, "fix");
      manager.assign(run);
      await finished.promise;
      expect(seeded).toEqual([[run.runId, 9]]);
      expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
    });

    test("derives pushed so github_pr works after a skipped git_push", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      deps.rpc = async <T>(method: string) =>
        method === "github.createPullRequest" ? ({ url: "https://github.com/acme/widget/pull/9" } as T) : Promise.reject(new Error(`no rpc: ${method}`));
      const run = withWorktree(
        resumed(
          {
            workspace: { kind: "local_path", path: repo },
            steps: [
              { kind: "prompt", id: "done", name: "Done", prompt: "earlier" },
              { kind: "git_push", id: "push", name: "Push" },
              { kind: "github_pr", id: "pr", name: "PR", titleFrom: "done", bodyFrom: "done" },
            ],
          },
          "pr",
          ["push"],
        ),
      );
      await runJob(run, deps, new AbortController().signal);
      // Without the derived flag this throws "github_pr requires an earlier git_push" and the run fails.
      expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
      expect(ofType(events, "step.started").map((e) => e.stepId)).toEqual(["pr"]);
    });

    test("tail skips pre-existing session files", async () => {
      const { deps, events } = harnessDeps(new FakeSandboxProvider());
      const run = resumed({ steps: [{ kind: "prompt", id: "fix", name: "Fix", prompt: "x" }] }, "fix");
      // Pre-existing attempt-1 subagent transcript in the run's sessions dir.
      const sessionsDir = join(config.dataDir, "runs", run.runId, "sessions");
      mkdirSync(join(sessionsDir, "attempt1"), { recursive: true });
      writeFileSync(join(sessionsDir, "attempt1.jsonl"), "{}\n");
      writeFileSync(join(sessionsDir, "attempt1", "Agent1.jsonl"), `${JSON.stringify({ agentId: "Agent1", role: "assistant", content: "old" })}\n`);
      await runJob(run, deps, new AbortController().signal);
      expect(ofType(events, "subagent.message")).toEqual([]);
    });

    test("worktree adopt: retry keeps the attempt-1 tree; from step 0 resets it to the base ref", async () => {
      // Attempt 1 (fresh): the write step creates hello.txt, the slash step fails (fake-print exits 3
      // on "fail") and stops the run with the worktree dirty.
      const { deps } = harnessDeps(new FakeSandboxProvider());
      const run = assigned({
        steps: [
          { kind: "prompt", id: "write", name: "Write", prompt: "write hello.txt" },
          { kind: "slash", id: "break", name: "Break", command: "review", args: "fail" },
        ],
      });
      await runJob(run, deps, new AbortController().signal);
      const worktree = join(config.dataDir, "worktrees", run.runId);
      expect(sh(worktree, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(`orch/${run.runId.slice(0, 10).toLowerCase()}`);
      expect(existsSync(join(worktree, "hello.txt"))).toBe(true);

      // Attempt 2 from step 1 adopts the worktree (no `worktree add` failure) and keeps the tree:
      // the file attempt 1 wrote is still there for the resumed step.
      const attempt2 = resumed(
        {
          steps: [
            { kind: "prompt", id: "write", name: "Write", prompt: "write hello.txt" },
            { kind: "slash", id: "break", name: "Break", command: "review", args: "fail" },
            { kind: "prompt", id: "fix", name: "Fix", prompt: "read hello.txt" },
          ],
        },
        "fix",
      );
      attempt2.runId = run.runId;
      const second = harnessDeps(new FakeSandboxProvider());
      await runJob(attempt2, second.deps, new AbortController().signal);
      expect(second.sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
      expect(sh(worktree, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(`orch/${run.runId.slice(0, 10).toLowerCase()}`);
      expect(existsSync(join(worktree, "hello.txt"))).toBe(true);
      const fixOutput = ofType(second.events, "step.finished")[0]!.payload.output;
      expect(fixOutput).toContain("hi");

      // Attempt 2 from step 0 is a fresh rerun: the worktree resets to the base ref (no hello.txt);
      // the flow rerun is all-green so it can run every step again.
      const restart = resumed(
        {
          steps: [
            { kind: "prompt", id: "write2", name: "Write", prompt: "write fresh.txt" },
            { kind: "prompt", id: "fix2", name: "Fix", prompt: "read fresh.txt" },
          ],
        },
        "write2",
      );
      restart.runId = run.runId;
      restart.resume!.fromStepIdx = 0;
      const third = harnessDeps(new FakeSandboxProvider());
      await runJob(restart, third.deps, new AbortController().signal);
      expect(third.sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
      // The reset wiped attempt 1's hello.txt (write2's own output is a different file).
      expect(existsSync(join(worktree, "hello.txt"))).toBe(false);
      expect(existsSync(join(worktree, "fresh.txt"))).toBe(true);
    });

    test("an intervention retried after a cancel can chat again: slash sessions resume, the agent session is new", async () => {
      const steps: FlowDefinitionInput["steps"] = [
        { kind: "slash", id: "plan", name: "Plan", command: "plan", args: "an app" },
        { kind: "prompt", id: "impl", name: "Implement", prompt: "hi" },
        { kind: "intervention", id: "gate", name: "Gate" },
      ];
      // Attempt 1 is cancelled at the gate.
      const first = harnessDeps(new FakeSandboxProvider());
      const run = assigned({ steps });
      await runJob(run, first.deps, new AbortController().signal, scriptedGate(first.deps, first.events, [{ action: "cancel" }]));
      expect(first.sent.at(-1)).toMatchObject({ status: "cancelled" });

      const retry = assigned({ steps });
      retry.runId = run.runId;
      retry.resume = { fromStepIdx: 2, prior: [{ stepId: "plan", output: "print:/plan an app\n" }, { stepId: "impl", output: "Hello, world" }] };
      const second = harnessDeps(new FakeSandboxProvider());
      const pending = scriptedGate(second.deps, second.events, [
        { action: "message", session: "slash:plan", text: "add tests" },
        { action: "message", session: "agent", text: "echo again" },
        { action: "continue", session: "agent" },
      ]);
      await runJob(retry, second.deps, new AbortController().signal, pending);

      expect(second.sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
      const requests = ofType(second.events, "intervention.request");
      expect(requests[0]!.payload.sessions).toEqual([
        { id: "slash:plan", label: "/plan (Plan)", output: "print:/plan an app\n" },
        { id: "agent", label: "Agent session (new after retry; last step: Implement)", output: "Hello, world" },
      ]);
      expect(requests[0]!.payload.session).toBe("agent");
      // The slash session continues attempt 1's omp session; the agent session takes messages again.
      expect(requests[1]!.payload.sessions[0]!.output).toBe("print:(resumed fake) add tests\n");
      const finished = Object.fromEntries(ofType(second.events, "step.finished").map((e) => [e.stepId, e.payload]));
      expect(finished.gate).toMatchObject({ status: "succeeded" });
      expect(finished.gate!.output).toContain("echo again");
    });

    test("a retried intervention without a session snapshot still offers the agent session", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      const pending = scriptedGate(deps, events, [{ action: "message", session: "agent", text: "echo again" }, { action: "continue" }]);
      const run = withWorktree(
        resumed(
          {
            steps: [
              { kind: "prompt", id: "done", name: "Implement", prompt: "hi" },
              { kind: "intervention", id: "gate", name: "Gate" },
            ],
          },
          "gate",
        ),
      );
      await runJob(run, deps, new AbortController().signal, pending);

      expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
      expect(ofType(events, "intervention.request")[0]!.payload.sessions).toEqual([
        { id: "agent", label: "Agent session (new after retry; last step: Implement)", output: "prior-output" },
      ]);
      expect(ofType(events, "step.finished")[0]!.payload.output).toContain("echo again");
    });

    test("worktree gone: a mid-run retry fails; from step 0 recreates it on the existing branch", async () => {
      const steps: FlowDefinitionInput["steps"] = [
        { kind: "prompt", id: "write", name: "Write", prompt: "write hello.txt" },
        { kind: "slash", id: "break", name: "Break", command: "review", args: "fail" },
      ];
      const run = assigned({ steps });
      await runJob(run, harnessDeps(new FakeSandboxProvider()).deps, new AbortController().signal);
      const worktree = join(config.dataDir, "worktrees", run.runId);
      const branch = `orch/${run.runId.slice(0, 10).toLowerCase()}`;
      // The branch survives in the repo, the worktree dir does not (e.g. dataDir wiped).
      rmSync(worktree, { recursive: true, force: true });

      const retry = resumed({ steps }, "break");
      retry.runId = run.runId;
      const second = harnessDeps(new FakeSandboxProvider());
      await runJob(retry, second.deps, new AbortController().signal);
      const failed = second.sent.at(-1);
      expect(failed).toMatchObject({ t: "job.finished", runId: run.runId, status: "failed" });
      expect(failed && "error" in failed ? failed.error : "").toContain("not on this runner");

      const restart = resumed({ steps: [{ kind: "prompt", id: "write2", name: "Write", prompt: "write fresh.txt" }] }, "write2");
      restart.runId = run.runId;
      restart.resume!.fromStepIdx = 0;
      const third = harnessDeps(new FakeSandboxProvider());
      await runJob(restart, third.deps, new AbortController().signal);
      expect(third.sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
      expect(sh(worktree, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
      // Reset to the base ref: attempt 1's uncommitted hello.txt is gone with its dir anyway.
      expect(existsSync(join(worktree, "hello.txt"))).toBe(false);
      expect(existsSync(join(worktree, "fresh.txt"))).toBe(true);
    });

    test("a retry supersedes a still-running attempt: aborts and silences it, then seeds and runs", async () => {
      const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
      const order: string[] = [];
      const gateOpen = Promise.withResolvers<void>();
      const retryDone = Promise.withResolvers<void>();
      deps.emit = (draft) => {
        events.push(draft);
        if (draft.type === "intervention.request") gateOpen.resolve();
      };
      deps.send = (msg) => {
        sent.push(msg);
        if (msg.t === "job.finished") {
          order.push("finished");
          retryDone.resolve();
        }
      };
      deps.seedOutbox = () => order.push("seed");
      const manager = new JobManager(deps);
      // Attempt 1 waits at a gate indefinitely (e.g. the server lost the runner and failed the run).
      const first = assigned({ steps: [{ kind: "intervention", id: "gate", name: "Gate" }] });
      manager.assign(first);
      await gateOpen.promise;
      const eventsBefore = events.length;
      const sentBefore = sent.length;

      const retry = resumed({ steps: [{ kind: "prompt", id: "fix", name: "Fix", prompt: "x" }] }, "fix");
      retry.runId = first.runId;
      manager.assign(retry);
      expect(manager.activeCount()).toBe(1);
      await retryDone.promise;

      // Only the retry's own output follows its arrival: attempt 1's cancellation never surfaces.
      expect(order).toEqual(["seed", "finished"]);
      expect(sent.slice(sentBefore).filter((m) => m.t === "job.finished")).toEqual([
        { t: "job.finished", runId: first.runId, status: "succeeded" },
      ]);
      const later = events.slice(eventsBefore);
      expect(ofType(later, "step.started").map((e) => e.stepId)).toEqual(["fix"]);
      expect(ofType(later, "step.finished").map((e) => [e.stepId, e.payload.status])).toEqual([["fix", "succeeded"]]);
      expect(ofType(later, "run.status").map((e) => e.payload.status)).not.toContain("cancelled");
    });
  });
});

describe("runJob: untrusted pull request runs", () => {
  const prFlow = (steps: FlowDefinitionInput["steps"]): Partial<FlowDefinitionInput> & Pick<FlowDefinitionInput, "steps"> => ({
    workspace: { kind: "github_checkout" },
    inputs: [{ key: "pr", label: "Pull request", type: "github_pull_request", required: true }],
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
    expect(ofType(events, "run.status")[0]!.payload).toEqual({
      status: "running",
      workspace: { path: checkout, repo: "acme/widget" },
    });
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

  test("github_comment posts the comment body via RPC", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    deps.config = { ...config, acceptUntrusted: true };
    deps.githubGitUrl = `file://${ghRoot}`;
    const rpcCalls: { method: string; params: unknown }[] = [];
    deps.rpc = async <T>(method: string, params: unknown) => {
      rpcCalls.push({ method, params });
      return (method === "github.createComment" ? { url: "https://github.com/acme/widget/pull/7#issuecomment-1" } : { token: "read-token" }) as T;
    };
    const run = prRun([
      { kind: "prompt", id: "write", name: "Write", prompt: "echo comment" },
      { kind: "github_comment", id: "post", name: "Post", target: "pr", bodyFrom: "write" },
    ]);
    await runJob(run, deps, new AbortController().signal);

    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
    const [written, posted] = ofType(events, "step.finished").map((e) => e.payload);
    const params: CreateCommentParams = { runId: run.runId, stepId: "post", body: written!.output! };
    expect(rpcCalls.filter((c) => c.method === "github.createComment")).toEqual([{ method: "github.createComment", params }]);
    expect(posted).toMatchObject({ status: "succeeded", output: "https://github.com/acme/widget/pull/7#issuecomment-1" });
  });

  test("github_comment with an empty body fails without calling the RPC", async () => {
    const { deps, events } = harnessDeps(new FakeSandboxProvider());
    deps.config = { ...config, acceptUntrusted: true };
    deps.githubGitUrl = `file://${ghRoot}`;
    const methods: string[] = [];
    deps.rpc = async <T>(method: string) => {
      methods.push(method);
      return { token: "read-token" } as T;
    };
    // Attempt 2 resumes at the comment step; the prior writer step produced only whitespace.
    const run: AssignedRun = {
      ...prRun([
        { kind: "prompt", id: "write", name: "Write", prompt: "x" },
        { kind: "github_comment", id: "post", name: "Post", target: "pr", bodyFrom: "write" },
      ]),
      resume: { fromStepIdx: 1, prior: [{ stepId: "write", output: "  \n" }] },
    };
    await runJob(run, deps, new AbortController().signal);
    expect(methods).not.toContain("github.createComment");
    expect(ofType(events, "step.finished").at(-1)!.payload).toMatchObject({ status: "failed", error: "Comment body from step write is empty" });
  });

  test("owner local-path runs can comment on a github_issue input", async () => {
    const { deps, events, sent } = harnessDeps(new FakeSandboxProvider());
    const rpcCalls: { method: string; params: unknown }[] = [];
    deps.rpc = async <T>(method: string, params: unknown) => {
      rpcCalls.push({ method, params });
      return { url: "https://github.com/acme/widget/issues/3#issuecomment-2" } as T;
    };
    const run = assigned({
      inputs: [{ key: "issue", label: "Issue", type: "github_issue", required: true }],
      steps: [
        { kind: "prompt", id: "write", name: "Write", prompt: "echo triage" },
        { kind: "github_comment", id: "post", name: "Post", target: "issue", bodyFrom: "write" },
      ],
    });
    run.inputs.issue = { url: "https://github.com/acme/widget/issues/3", repo: "acme/widget", number: 3, title: "Bug", body: "Broken" };
    await runJob(run, deps, new AbortController().signal);

    expect(sent.at(-1)).toEqual({ t: "job.finished", runId: run.runId, status: "succeeded" });
    const [written, posted] = ofType(events, "step.finished").map((e) => e.payload);
    expect(rpcCalls).toEqual([{ method: "github.createComment", params: { runId: run.runId, stepId: "post", body: written!.output! } }]);
    expect(posted).toMatchObject({ status: "succeeded", output: "https://github.com/acme/widget/issues/3#issuecomment-2" });
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
