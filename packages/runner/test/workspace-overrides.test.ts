// Task child-run overrides (issue #34): the worktree starts from `refs/orch/remote/<baseBranch>`
// (host-fetched with a read token), never touches `refs/remotes/*`, and force-with-lease pushes
// refuse remote work the runner has not seen.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssignedRun, FlowDefinition, type GitHubTokenParams } from "@orch/protocol";
import { ulid } from "ulid";
import type { RunnerConfig } from "../src/config";
import { pushBranch, remoteBranchSha } from "../src/git";
import type { WorkspaceContext } from "../src/workspace";
import { forcePushLease, prepareWorkspace, resolveWorkspacePath } from "../src/workspace";

let root: string;
let config: RunnerConfig;
/** Local bare remote standing in for `<gitUrl>/acme/widget.git` (tests point `gitUrl` at `ghRoot`). */
let ghRoot: string;
let work: string;
let baseSha: string;
let taskBranchSha: string;

function sh(cwd: string, ...argv: string[]): string {
  const res = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

function commit(cwd: string, msg: string): string {
  sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", msg);
  return sh(cwd, "git", "rev-parse", "HEAD");
}

const TOKEN_RPC: GitHubTokenParams = { runId: "ignored", repo: "acme/widget", access: "read" };

function wctx(runId: string): WorkspaceContext {
  return {
    runDir: join(config.dataDir, "runs", runId),
    rpc: async <T>(_method: string, params: unknown) => {
      expect(params).toEqual({ ...TOKEN_RPC, runId });
      return { token: "read-token" } as T;
    },
    gitUrl: `file://${ghRoot}`,
    log: () => {},
  };
}

function assignedRun(over: Partial<AssignedRun> = {}): AssignedRun {
  const definition = FlowDefinition.parse({
    name: "task-child",
    workspace: { kind: "local_path", path: repoPath },
    harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
    steps: [{ kind: "prompt", id: "p", name: "P", prompt: "x" }],
  });
  return { runId: ulid(), trust: "owner", definition, inputs: {}, ...over };
}

let repoPath: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wsover-")));
  config = {
    serverUrl: "ws://127.0.0.1:1/runner/ws",
    token: "t",
    runnerId: "test-runner",
    labels: [],
    maxConcurrentJobs: 1,
    maxManagers: 1,
    allowedRoots: [root],
    acceptUntrusted: false,
    dataDir: join(root, "data"),
    skillDirs: [],
    commandDirs: [],
    ports: { mcp: 7802, broker: 7803, gateway: 7804 },
    hostBind: "127.0.0.1",
    git: {},
  };
  // The local clone (a task repo localPath) with a GitHub-shaped origin, like job.test.ts sets up.
  repoPath = join(root, "repo");
  ghRoot = join(root, "gh");
  mkdirSync(repoPath);
  sh(repoPath, "git", "init", "-q", "-b", "main");
  writeFileSync(join(repoPath, "a.txt"), "a\n");
  sh(repoPath, "git", "add", ".");
  baseSha = commit(repoPath, "init");
  sh(repoPath, "git", "remote", "add", "origin", "https://github.com/acme/widget.git");

  // The bare remote: `main` (base) and `orch/task-1` (integration branch with a newer commit).
  work = join(root, "work");
  mkdirSync(work);
  sh(work, "git", "init", "-q", "-b", "main");
  writeFileSync(join(work, "b.txt"), "b\n");
  sh(work, "git", "add", ".");
  commit(work, "remote base");
  sh(work, "git", "checkout", "-q", "-b", "orch/task-1");
  writeFileSync(join(work, "c.txt"), "c\n");
  sh(work, "git", "add", ".");
  taskBranchSha = commit(work, "on integration branch");
  mkdirSync(join(ghRoot, "acme"), { recursive: true });
  sh(root, "git", "clone", "-q", "--bare", work, join(ghRoot, "acme", "widget.git"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("worktree overrides", () => {
  test("the worktree starts from refs/orch/remote/<baseBranch>, refs/remotes/* untouched", async () => {
    const run = assignedRun({ overrides: { baseBranch: "orch/task-1", fetchBranches: ["main"], prBase: "orch/task-1" } });
    const ws = await prepareWorkspace(run, config, wctx(run.runId));

    // The worktree branch is still the run's own orch/<runId> branch, but its HEAD is the fetched
    // base branch's sha, not the local main HEAD.
    expect(ws.branch).toBe(`orch/${run.runId.slice(0, 10).toLowerCase()}`);
    expect(ws.overrides).toEqual({ baseBranch: "orch/task-1", fetchBranches: ["main"], prBase: "orch/task-1" });
    expect(sh(ws.hostPath, "git", "rev-parse", "HEAD")).toBe(taskBranchSha);
    expect(sh(ws.hostPath, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe(ws.branch!);
    // The worktree sees the fetched branch and has c.txt (only on orch/task-1).
    expect(sh(ws.hostPath, "git", "rev-parse", "refs/orch/remote/orch/task-1")).toBe(taskBranchSha);
    expect(sh(ws.hostPath, "git", "rev-parse", "refs/orch/remote/main")).toBe(sh(work, "git", "rev-parse", "main"));
    expect(sh(ws.hostPath, "git", "show", "--name-only", "--format=", "HEAD")).toBe("c.txt");

    // The user's remote-tracking refs were never touched: the clone has no refs/remotes at all
    // (only the bare remote's own ones, which are its local branches).
    const refs = sh(repoPath, "git", "for-each-ref", "--format=%(refname)");
    expect(refs.split("\n").filter((r) => r.startsWith("refs/remotes/"))).toEqual([]);
    // The fetched orchestrator refs live in the shared repo (worktrees write into the common dir).
    expect(sh(repoPath, "git", "rev-parse", "refs/orch/remote/orch/task-1")).toBe(taskBranchSha);
  });

  test("re-running after a fetched start does not re-fetch mid-run (continuing resumes)", async () => {
    const run = assignedRun({ overrides: { baseBranch: "orch/task-1" } });
    const ws = await prepareWorkspace(run, config, wctx(run.runId));
    // Simulate a resume from step 1 of the same run id: the workspace must be adopted, not reset.
    const resumeRun = assignedRun({ overrides: { baseBranch: "orch/task-1" } });
    resumeRun.runId = run.runId;
    resumeRun.resume = { fromStepIdx: 1, prior: [] };
    const ws2 = await prepareWorkspace(resumeRun, config, wctx(run.runId));
    expect(ws2.hostPath).toBe(ws.hostPath);
    expect(sh(ws2.hostPath, "git", "rev-parse", "HEAD")).toBe(taskBranchSha);
  });
});

describe("force-with-lease push", () => {
  test("succeeds when the lease matches and fails when the remote moved", async () => {
    // A second clone to push from, like a worktree would be.
    const clone = join(root, "push-clone");
    sh(root, "git", "clone", "-q", `file://${ghRoot}/acme/widget.git`, clone);
    sh(clone, "git", "checkout", "-q", "-b", "orch/run-a", "origin/orch/task-1");
    writeFileSync(join(clone, "d.txt"), "d\n");
    sh(clone, "git", "add", ".");
    const firstSha = commit(clone, "push me");

    // First push creates the remote branch (no lease).
    await pushBranch(clone, { owner: "acme", name: "widget" }, "orch/run-a", "t", undefined, undefined, `file://${ghRoot}`);

    // Second push with a lease matching the remote sha (what the runner fetched): succeeds.
    writeFileSync(join(clone, "e.txt"), "e\n");
    sh(clone, "git", "add", ".");
    const secondSha = commit(clone, "second push");
    await pushBranch(clone, { owner: "acme", name: "widget" }, "orch/run-a", "t", undefined, firstSha, `file://${ghRoot}`);
    // Read the branch where the push went: the bare remote, not the `work` repo it was cloned from.
    expect(sh(join(ghRoot, "acme", "widget.git"), "git", "rev-parse", "refs/heads/orch/run-a")).toBe(secondSha);

    // A lease against the stale sha (the remote moved since): the push must be refused.
    writeFileSync(join(clone, "g.txt"), "g\n");
    sh(clone, "git", "add", ".");
    commit(clone, "third push");
    let failed = "";
    try {
      await pushBranch(clone, { owner: "acme", name: "widget" }, "orch/run-a", "t", undefined, firstSha, `file://${ghRoot}`);
    } catch (err) {
      failed = (err as Error).message;
    }
    expect(failed).toContain("push failed");
    expect(sh(join(ghRoot, "acme", "widget.git"), "git", "rev-parse", "refs/heads/orch/run-a")).toBe(secondSha);
  });

  test("an empty lease refuses to create a branch that exists on the remote", async () => {
    const clone = join(root, "push-clone-2");
    sh(root, "git", "clone", "-q", `file://${ghRoot}/acme/widget.git`, clone);
    sh(clone, "git", "checkout", "-q", "-b", "orch/run-b", "origin/orch/task-1");
    writeFileSync(join(clone, "f.txt"), "f\n");
    sh(clone, "git", "add", ".");
    commit(clone, "lease empty");
    let failed = "";
    try {
      await pushBranch(clone, { owner: "acme", name: "widget" }, "orch/task-1", "t", undefined, "", `file://${ghRoot}`);
    } catch (err) {
      failed = (err as Error).message;
    }
    expect(failed).toContain("push failed");
  });

  test("a run leases against what it found, not a later fetch by another run nor refs its sandbox can rewrite", async () => {
    const bare = join(ghRoot, "acme", "widget.git");
    const pusher = join(root, "lease-pusher");
    sh(root, "git", "clone", "-q", `file://${bare}`, pusher);
    sh(pusher, "git", "checkout", "-q", "-b", "orch/pr-head", "origin/orch/task-1");
    sh(pusher, "git", "push", "-q", "origin", "orch/pr-head");
    const h0 = sh(pusher, "git", "rev-parse", "HEAD");
    const overrides = { baseBranch: "orch/pr-head", pushBranch: "orch/pr-head", forcePush: true };
    const runA = assignedRun({ overrides });
    const wsA = await prepareWorkspace(runA, config, wctx(runA.runId));

    // Someone pushes H1, then run B fetches the same branch: the shared refs/orch/remote/orch/pr-head moves to H1.
    writeFileSync(join(pusher, "h1.txt"), "h1\n");
    sh(pusher, "git", "add", ".");
    const h1 = commit(pusher, "h1");
    sh(pusher, "git", "push", "-q", "origin", "orch/pr-head");
    const runB = assignedRun({ overrides });
    await prepareWorkspace(runB, config, wctx(runB.runId));
    expect(sh(repoPath, "git", "rev-parse", "refs/orch/remote/orch/pr-head")).toBe(h1);
    // Run A's sandbox mounts the git dir read-write: whatever it does to refs there must not move the lease.
    for (const ref of sh(repoPath, "git", "for-each-ref", "--format=%(refname)", "refs/orch").split("\n")) {
      sh(repoPath, "git", "update-ref", ref, h1);
    }

    // Run A still leases against H0, so its force-push is refused instead of overwriting H1.
    const lease = await forcePushLease(wctx(runA.runId).runDir);
    expect(lease).toBe(h0);
    writeFileSync(join(wsA.hostPath, "a2.txt"), "a2\n");
    sh(wsA.hostPath, "git", "add", ".");
    commit(wsA.hostPath, "run A's work");
    let failed = "";
    try {
      await pushBranch(wsA.hostPath, { owner: "acme", name: "widget" }, "orch/pr-head", "t", undefined, lease, `file://${ghRoot}`);
    } catch (err) {
      failed = (err as Error).message;
    }
    expect(failed).toContain("push failed");
    expect(sh(bare, "git", "rev-parse", "refs/heads/orch/pr-head")).toBe(h1);
    // Run B, which saw H1, leases against it.
    expect(await forcePushLease(wctx(runB.runId).runDir)).toBe(h1);
  });

  test("the lease reads the exact branch, not a decoy ref ending in its name", async () => {
    const bare = join(ghRoot, "acme", "widget.git");
    // Sorts before `refs/heads/orch/task-1`, and `ls-remote <pattern>` lists both.
    const decoy = "refs/heads/a/refs/heads/orch/task-1";
    sh(bare, "git", "update-ref", decoy, sh(bare, "git", "rev-parse", "refs/heads/main"));
    try {
      expect(await remoteBranchSha(repoPath, `file://${bare}`, "orch/task-1", "t")).toBe(sh(bare, "git", "rev-parse", "refs/heads/orch/task-1"));
    } finally {
      sh(bare, "git", "update-ref", "-d", decoy);
    }
  });
});

describe("workspaceRoot containment", () => {
  // The server checks the path text only; a symlink inside the task repo pointing elsewhere passes that check.
  test("a workspace resolving outside the task repo root is refused; inside passes", async () => {
    const outside = join(root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(repoPath, "escape"));
    expect(await resolveWorkspacePath(repoPath, config.allowedRoots, repoPath)).toBe(repoPath);
    await expect(resolveWorkspacePath(join(repoPath, "escape"), config.allowedRoots, repoPath)).rejects.toThrow(
      "Workspace path outside the task repository",
    );
    await expect(resolveWorkspacePath(join(repoPath, "..", "elsewhere"), config.allowedRoots, repoPath)).rejects.toThrow(
      "Workspace path outside the task repository",
    );
  });
});
