import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type AssignedRun,
  type GitHubTokenParams,
  type GitHubTokenResult,
  type LocalPathWorkspace,
  PR_DIFF_PATH,
  fetchedBranchRef,
  hasBranchOverrides,
  type RunOverrides,
} from "@orch/protocol";
import type { RunnerConfig } from "./config";
import { isWithinRoot } from "./fs-rpc";
import { fetchBranches, fetchShas, git, gitOk, originRepo, remoteBranchSha } from "./git";
import type { Mount } from "./sandbox/types";

/** Default origin for PR checkouts; tests point it at a local `file://` dir. */
export const GITHUB_GIT_URL = "https://github.com";
/** History fetched per PR side; enough for the merge base of typical PRs. */
const CHECKOUT_DEPTH = 200;

export interface WorkspaceContext {
  runDir: string;
  rpc<T>(method: "github.token", params: GitHubTokenParams): Promise<T>;
  /** Git origin PR repos are fetched from (`<gitUrl>/<owner>/<name>.git`). */
  gitUrl: string;
  /** Diagnostic line for the run's `sandbox.log`. */
  log(text: string): void;
  signal?: AbortSignal;
}

export interface PreparedWorkspace {
  /** Host path the harness runs in (worktree, direct path, or PR checkout); mounted at the identical path. */
  hostPath: string;
  mounts: Mount[];
  branch?: string;
  repo?: { owner: string; name: string };
  /** Task child-run overrides in effect (worktree runs only; absent on continuing resumes). */
  overrides?: RunOverrides;
}

/** Realpaths `path` and enforces `allowedRoots`; the runner never trusts the server for this. */
export async function resolveAllowedPath(path: string, allowedRoots: string[]): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new Error(`Workspace path does not exist: ${path}`);
  }
  if (!allowedRoots.some((root) => isWithinRoot(real, root))) throw new Error("Path outside allowedRoots");
  return real;
}

/**
 * `resolveAllowedPath` plus, for task child runs, containment in the task repo `workspaceRoot`: both sides are
 * realpathed here, so a `..` or a symlink in the flow's path cannot reach outside the task's repos even though the
 * server only checked the text.
 */
export async function resolveWorkspacePath(path: string, allowedRoots: string[], workspaceRoot?: string): Promise<string> {
  const real = await resolveAllowedPath(path, allowedRoots);
  if (workspaceRoot === undefined) return real;
  let root: string;
  try {
    root = await realpath(workspaceRoot);
  } catch {
    throw new Error(`Task repository path does not exist: ${workspaceRoot}`);
  }
  if (!isWithinRoot(real, root)) throw new Error("Workspace path outside the task repository");
  return real;
}

export function orchBranch(runId: string): string {
  return `orch/${runId.slice(0, 10).toLowerCase()}`;
}

/** Read-only overlays that stop the sandbox from planting hooks or `core.fsmonitor` in the host repo. */
async function gitOverlays(gitDir: string, createHooks: boolean): Promise<Mount[]> {
  const hooks = join(gitDir, "hooks");
  if (createHooks && !existsSync(hooks)) await mkdir(hooks, { recursive: true });
  const mounts: Mount[] = [];
  for (const p of [hooks, join(gitDir, "config")]) {
    if (existsSync(p)) mounts.push({ hostPath: p, containerPath: p, readonly: true });
  }
  return mounts;
}

/** Host dir of a run's PR checkout; deleted after the run. */
export function checkoutDir(config: RunnerConfig, runId: string): string {
  return join(config.dataDir, "checkouts", runId);
}

export async function prepareWorkspace(run: AssignedRun, config: RunnerConfig, wctx: WorkspaceContext): Promise<PreparedWorkspace> {
  const ws = run.definition.workspace;
  if (ws.kind === "github_checkout") return prepareCheckout(run, config, wctx);
  return prepareLocalPath(run, ws, config, wctx);
}

/**
 * Fetches the PR head and base on the host (never in the sandbox) with a read-only installation
 * token, checks out the head detached, and writes the PR diff into `<runDir>/context`.
 * Both are mounted read-only.
 */
async function prepareCheckout(run: AssignedRun, config: RunnerConfig, wctx: WorkspaceContext): Promise<PreparedWorkspace> {
  const gh = run.github;
  if (!gh) throw new Error("github_checkout requires a pull request run");
  const { signal } = wctx;
  const { token } = await wctx.rpc<GitHubTokenResult>("github.token", { runId: run.runId, repo: gh.repo, access: "read" });
  const dir = checkoutDir(config, run.runId);
  await mkdir(dir, { recursive: true });
  await gitOk(dir, ["init", "--quiet"], { signal });
  await fetchShas(dir, `${wctx.gitUrl}/${gh.repo}.git`, [gh.headSha, gh.baseSha], token, CHECKOUT_DEPTH, signal);
  await gitOk(dir, ["checkout", "--quiet", "--detach", gh.headSha], { signal });

  let diff = await git(dir, ["diff", `${gh.baseSha}...${gh.headSha}`], { signal });
  if (diff.code !== 0) {
    wctx.log(`PR merge base not in the fetched history (depth ${CHECKOUT_DEPTH}); pr.diff is a two-dot diff base..head`);
    diff = await git(dir, ["diff", gh.baseSha, gh.headSha], { signal });
    if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim() || `exit ${diff.code}`}`);
  }
  const contextDir = join(wctx.runDir, "context");
  await mkdir(contextDir, { recursive: true });
  await writeFile(join(contextDir, basename(PR_DIFF_PATH)), diff.stdout);
  const [owner, name] = gh.repo.split("/") as [string, string];
  return {
    hostPath: dir,
    repo: { owner, name },
    mounts: [
      { hostPath: dir, containerPath: dir, readonly: true },
      { hostPath: contextDir, containerPath: dirname(PR_DIFF_PATH), readonly: true },
    ],
  };
}

/**
 * Host-only record of the push target as this run found it: its `forcePush` lease, in the run dir (whose root no
 * sandbox mounts; only subdirs like `sessions/` are). Not a ref: the repo's git dir is mounted read-write into
 * worktree sandboxes, so the agent could move any ref there (or another run's fetch moves the shared
 * `refs/orch/remote/<branch>`) and the lease would accept remote work this run never saw. A file, not memory: a
 * continuing resume on the same runner (it holds the worktree) still leases against the original fetch.
 */
const PUSH_LEASE_FILE = "push-lease.json";

/**
 * The `--force-with-lease` expectation for the push of the run whose run dir is `runDir`: the push target's sha
 * as the run found it, or null (the remote branch must not exist) when it recorded none or the branch was missing.
 */
export async function forcePushLease(runDir: string): Promise<string | null> {
  try {
    const { sha } = JSON.parse(await readFile(join(runDir, PUSH_LEASE_FILE), "utf8")) as { sha: string | null };
    return sha;
  } catch {
    return null;
  }
}

/**
 * Fetches the override branches (base, extra, push target) of a task child run on the host with a read-only
 * token, each into `refs/orch/remote/<branch>` so the user's `refs/remotes/*` stay untouched. The GitHub
 * repo comes from the worktree's parsed `origin` remote (`<gitUrl>/<owner>/<name>.git`). With `forcePush`, the
 * push target's remote sha is recorded first (`PUSH_LEASE_FILE`): read before the fetch, it is never newer than the
 * push target the run fetched and works from, so a push after a remote move is refused rather than overwriting it.
 */
async function fetchOverrides(run: AssignedRun, repo: { owner: string; name: string }, path: string, wctx: WorkspaceContext): Promise<void> {
  const ov = run.overrides;
  if (!ov) return;
  const branches = [ov.baseBranch, ...(ov.fetchBranches ?? []), ov.pushBranch].filter((b): b is string => b !== undefined);
  const unique = [...new Set(branches)];
  if (unique.length === 0) return;
  const url = `${wctx.gitUrl}/${repo.owner}/${repo.name}.git`;
  const { token } = await wctx.rpc<GitHubTokenResult>("github.token", { runId: run.runId, repo: `${repo.owner}/${repo.name}`, access: "read" });
  if (ov.forcePush && ov.pushBranch !== undefined) {
    const sha = await remoteBranchSha(path, url, ov.pushBranch, token, wctx.signal);
    await mkdir(wctx.runDir, { recursive: true });
    await writeFile(join(wctx.runDir, PUSH_LEASE_FILE), JSON.stringify({ sha }));
  }
  await fetchBranches(path, url, unique, token, wctx.signal);
}

async function prepareLocalPath(run: AssignedRun, ws: LocalPathWorkspace, config: RunnerConfig, wctx: WorkspaceContext): Promise<PreparedWorkspace> {
  if (run.trust !== "owner") throw new Error("Untrusted runs cannot mount local paths");
  const path = await resolveWorkspacePath(ws.path, config.allowedRoots, run.overrides?.workspaceRoot);
  const gitDir = join(path, ".git");
  const repo = (await originRepo(path)) ?? undefined;

  if (ws.isolation === "worktree") {
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) throw new Error("worktree isolation requires a git repository");
    // Branch overrides only apply to fresh starts: a continuing resume keeps the previous attempt's tree
    // (fetching now could yank the push target out from under a mid-run force-with-lease).
    const overrides = run.overrides && hasBranchOverrides(run.overrides) && !run.resume?.fromStepIdx ? run.overrides : undefined;
    if (overrides && !repo) throw new Error("Overrides require a GitHub origin remote");
    if (overrides) await fetchOverrides(run, repo!, path, wctx);
    // `baseBranch` reroutes only the start point; the worktree branch stays the run's own.
    const baseRef = overrides?.baseBranch ? fetchedBranchRef(overrides.baseBranch) : ws.baseRef;
    const branch = orchBranch(run.runId);
    const worktree = join(config.dataDir, "worktrees", run.runId);
    await mkdir(join(config.dataDir, "worktrees"), { recursive: true });
    const continuing = (run.resume?.fromStepIdx ?? 0) > 0;
    if (existsSync(worktree)) {
      // `--show-toplevel`, not just `--git-dir`: a plain dir inside some other repo is not our worktree.
      const top = await git(worktree, ["rev-parse", "--show-toplevel"]);
      if (top.code !== 0 || (await realpath(top.stdout.trim())) !== (await realpath(worktree))) {
        throw new Error(`${worktree} exists but is not a git worktree; move it away to run this workspace`);
      }
      const head = await gitOk(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (continuing) {
        // Resume mid-run: keep the previous attempt's tree as-is — continuing where it stopped is the point.
        if (head !== branch) console.warn(`[workspace] resuming ${run.runId} in ${worktree} on ${head}, not ${branch}`);
      } else {
        // Fresh run or resume from step 0: restart clean from the base ref.
        if (head !== branch) await gitOk(worktree, ["checkout", "--force", branch]);
        await gitOk(worktree, ["reset", "--hard", baseRef]);
        await gitOk(worktree, ["clean", "-fd"]);
      }
    } else if (continuing) {
      throw new Error(`The previous attempt's worktree (${worktree}) is not on this runner; retry from the first step instead`);
    } else {
      // Drop stale registrations (worktree dir deleted) so the branch can be checked out again.
      await gitOk(path, ["worktree", "prune"]);
      if ((await git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) {
        await gitOk(path, ["worktree", "add", worktree, branch]);
        await gitOk(worktree, ["reset", "--hard", baseRef]);
      } else {
        await gitOk(path, ["worktree", "add", "-b", branch, worktree, baseRef]);
      }
    }
    return {
      hostPath: worktree,
      branch,
      repo,
      ...(overrides !== undefined ? { overrides } : {}),
      mounts: [
        { hostPath: worktree, containerPath: worktree, readonly: false },
        // Commits made in the worktree write objects and refs into the common dir.
        { hostPath: gitDir, containerPath: gitDir, readonly: false },
        ...(await gitOverlays(gitDir, true)),
      ],
    };
  }

  const readonly = ws.access === "ro";
  const mounts: Mount[] = [{ hostPath: path, containerPath: path, readonly }];
  if (!readonly && existsSync(gitDir) && statSync(gitDir).isDirectory()) mounts.push(...(await gitOverlays(gitDir, false)));
  return { hostPath: path, mounts, repo };
}
