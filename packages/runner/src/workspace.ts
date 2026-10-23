import { existsSync, statSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AssignedRun } from "@orch/protocol";
import type { RunnerConfig } from "./config";
import { isWithinRoot } from "./fs-rpc";
import { gitOk, originRepo } from "./git";
import type { Mount } from "./sandbox/types";

export interface PreparedWorkspace {
  /** Host path the harness runs in (worktree or direct path); mounted at the identical path. */
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

export async function prepareWorkspace(run: AssignedRun, config: RunnerConfig): Promise<PreparedWorkspace> {
  const ws = run.definition.workspace;
  if (run.trust !== "owner") throw new Error("Untrusted runs cannot mount local paths");
  const path = await resolveAllowedPath(ws.path, config.allowedRoots);
  const gitDir = join(path, ".git");
  const repo = (await originRepo(path)) ?? undefined;

  if (ws.isolation === "worktree") {
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) throw new Error("worktree isolation requires a git repository");
    const branch = orchBranch(run.runId);
    const worktree = join(config.dataDir, "worktrees", run.runId);
    await mkdir(join(config.dataDir, "worktrees"), { recursive: true });
    await gitOk(path, ["worktree", "add", "-b", branch, worktree, ws.baseRef]);
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
