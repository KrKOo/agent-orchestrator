import { existsSync, statSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type AssignedRun, type GitHubTokenParams, type GitHubTokenResult, type LocalPathWorkspace, PR_DIFF_PATH } from "@orch/protocol";
import type { RunnerConfig } from "./config";
import { isWithinRoot } from "./fs-rpc";
import { fetchShas, git, gitOk, originRepo } from "./git";
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
  return prepareLocalPath(run, ws, config);
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

async function prepareLocalPath(run: AssignedRun, ws: LocalPathWorkspace, config: RunnerConfig): Promise<PreparedWorkspace> {
  if (run.trust !== "owner") throw new Error("Untrusted runs cannot mount local paths");
  const path = await resolveAllowedPath(ws.path, config.allowedRoots);
  const gitDir = join(path, ".git");
  const repo = (await originRepo(path)) ?? undefined;

  if (ws.isolation === "worktree") {
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) throw new Error("worktree isolation requires a git repository");
    const branch = orchBranch(run.runId);
    const worktree = join(config.dataDir, "worktrees", run.runId);
    await mkdir(join(config.dataDir, "worktrees"), { recursive: true });
    const existing = existsSync(worktree) ? await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;
    if (existing?.code === 0 && existing.stdout.trim() === branch) {
      // Resume: the attempt-1 worktree is still there. From step 0 restart clean from the base ref
      // (fresh rerun semantics); otherwise keep the dirty tree — continuing where it stopped is the point.
      if (run.resume?.fromStepIdx === 0) {
        await gitOk(worktree, ["reset", "--hard", ws.baseRef]);
        await gitOk(worktree, ["clean", "-fd"]);
      }
    } else {
      await gitOk(path, ["worktree", "add", "-b", branch, worktree, ws.baseRef]);
    }
    return {
      hostPath: worktree,
      branch,
      repo,
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
