// Authorization + dispatch of every `manager.tool` RPC call (issue #34): the manager agent's only
// write path. Everything is checked against the calling manager run's task — child runs of the task
// only, the task's repos only — before the underlying run operation or GitHub call runs.
import {
  fetchedBranchRef,
  integrationBranch,
  isSafeBranch,
  ORCH_BRANCH_PREFIX,
  validateFlow,
  wrapUntrustedData,
  type FlowDefinition,
  type ManagerToolCall,
  type RunOverrides,
} from "@orch/protocol";
import { and, asc, eq } from "drizzle-orm";
import { posix } from "node:path";
import { ulid } from "ulid";
import { schema } from "./db";
import type { AppDeps } from "./deps";
import { GitHubError, parseIssueUrl, parsePullUrl } from "./github/api";
import { neutralizeMentions } from "./github/sanitize";
import { RESOLVE_CONFLICTS_FLOW_ID, resolveConflictsDefinition } from "./builtin-flows";
import { isTerminal } from "./runs";
import { cancelRun, respondIntervention, respondPermission, retryRun, startRun } from "./run-ops";
import { childPrUrls } from "./tasks";

const { flows, runSteps, runs } = schema;

/** Bodies posted to GitHub are mention-neutralized and capped (GitHub comments cap at 65 536 chars). */
const GH_BODY_MAX = 60_000;
/** Output cap for one step quoted in `get_run`. */
const STEP_OUTPUT_MAX = 4_000;

/** Errors from the dispatch, returned to the manager agent as the tool result. */
export class ManagerToolError extends Error {}

/** Flattens a run-ops `OpError` body (`{error}` or `{errors}`) into one message. */
function opErrorMessage(err: { body: { error?: string; errors?: string[] } }): string {
  if (err.body.error !== undefined) return err.body.error;
  return err.body.errors?.join("; ") ?? "operation failed";
}

/** The app graph pieces the run operations need (`run-ops.ts` takes them as `AppDeps`). */
export type ManagerToolDeps = AppDeps;

type TaskRecord = typeof schema.tasks.$inferSelect;
type RunRecord = typeof runs.$inferSelect;

/** Repo key comparison: GitHub owners and repo names are case-insensitive. */
function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * True when `path` equals `root` or lies below it after normalisation (trailing slashes ignored). A path with a
 * `..` segment never qualifies: the runner resolves it later, so it could leave `root`. Symlinks are the runner's
 * part: it re-checks the realpathed workspace against the realpathed `RunOverrides.workspaceRoot`.
 */
function underPath(path: string, root: string): boolean {
  if (path.split("/").includes("..")) return false;
  const p = posix.normalize(path).replace(/\/+$/, "");
  const r = posix.normalize(root).replace(/\/+$/, "") || "/";
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

/** Child runs of the task that may still run; `maxParallelRuns` caps them. */
function assertChildCapacity(deps: ManagerToolDeps, task: TaskRecord): void {
  const nonTerminal = deps.tasks.taskRuns(task.id).filter((r) => r.role === "worker" && !isTerminal(r.status)).length;
  if (nonTerminal >= task.settings.maxParallelRuns) {
    throw new ManagerToolError(
      `the task already has ${nonTerminal} non-terminal child runs (maxParallelRuns ${task.settings.maxParallelRuns})`,
    );
  }
}

/** Everything known about the calling manager run after the static checks. */
interface ManagerScope {
  run: RunRecord;
  task: TaskRecord;
}

/**
 * Static authorization for any `manager.tool` call: the caller holds the run, and the run is a
 * non-terminal owner manager run of a live task. A `done` task takes no more writes either: its manager is
 * being stopped (or finishing the turn that called `complete_task`, which passed this check before).
 */
export function authorizeScope(deps: ManagerToolDeps, runId: string): ManagerScope {
  const run = deps.tasks.run(runId);
  if (!run) throw new ManagerToolError("run not found");
  if (isTerminal(run.status)) throw new ManagerToolError("run is finished");
  if (run.role !== "manager") throw new ManagerToolError("only manager runs may call manager tools");
  if (run.trust !== "owner") throw new ManagerToolError("manager runs must be owner runs");
  const task = run.taskId ? deps.tasks.get(run.taskId) : undefined;
  if (!task) throw new ManagerToolError("task not found");
  if (task.status === "archived") throw new ManagerToolError("task is archived");
  if (task.status === "done") throw new ManagerToolError("task is done; the user reopens it to continue");
  return { run, task };
}

/**
 * The task right before a GitHub write: `authorizeScope` again, with `repo` still one of its repos. Tools await
 * GitHub before they write, and the user may archive or finish the task, drop the repo or change its settings
 * meanwhile: the write then checks the settings it depends on against this row, not the dispatch-time snapshot.
 */
function taskBeforeWrite(deps: ManagerToolDeps, runId: string, repo: string): TaskRecord {
  const task = authorizeScope(deps, runId).task;
  taskRepo(task, repo);
  return task;
}

/** The child run of the manager's task (role worker), or forbidden. */
function childRun(deps: ManagerToolDeps, scope: ManagerScope, runId: string): RunRecord {
  const child = deps.tasks.run(runId);
  if (!child) throw new ManagerToolError(`run ${runId} not found`);
  if (child.taskId !== scope.task.id || child.role !== "worker") {
    throw new ManagerToolError(`run ${runId} is not a child run of this task`);
  }
  return child;
}

/** The task repo whose local clone contains `path`, or null. */
function repoForPath(task: TaskRecord, path: string): TaskRecord["settings"]["repos"][number] | null {
  return task.settings.repos.find((r) => underPath(path, r.localPath)) ?? null;
}

/**
 * Flows the manager may see (`list_flows`, `get_flow`): its own and user flows (not other tasks'), whose
 * `local_path` workspace lies in a task repo; PR-checkout flows have no host path.
 */
function flowInScope(task: TaskRecord, flow: typeof flows.$inferSelect): boolean {
  if (flow.taskId !== null && flow.taskId !== task.id) return false;
  const ws = flow.definition.workspace;
  return ws.kind !== "local_path" || repoForPath(task, ws.path) !== null;
}

/** The task repo `owner/name`, or forbidden. */
function assertTaskRepo(task: TaskRecord, repo: string): void {
  if (!task.settings.repos.some((r) => sameRepo(r.github, repo))) {
    throw new ManagerToolError(`repository ${repo} is not part of this task`);
  }
}

/** Truncates one step output quoted in `get_run`. */
function cutOutput(text: string, max = STEP_OUTPUT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * A child run's own text (step output, error) as the manager sees it: cut first, then wrapped when the run is
 * untrusted (e.g. a fork PR checkout), so a cut never drops the closing tag and the text stays data.
 */
function runText(run: RunRecord, text: string): string {
  const cut = cutOutput(text);
  return run.trust === "untrusted" ? wrapUntrustedData(cut) : cut;
}

/**
 * A `local_path` workspace must be (inside) one of the task's repos; returns that repo. A writable one must be
 * a worktree: `direct` + `rw` would let the child change the user's live clone with no branch and no PR to
 * review, outside the integration-branch workflow. Read-only direct mounts (analysis) stay allowed.
 */
function checkWorkspace(task: TaskRecord, def: FlowDefinition): TaskRecord["settings"]["repos"][number] | null {
  if (def.workspace.kind !== "local_path") return null;
  const repo = repoForPath(task, def.workspace.path);
  if (repo === null) throw new ManagerToolError(`workspace ${def.workspace.path} is not inside a task repository`);
  if (def.workspace.access === "rw" && def.workspace.isolation !== "worktree") {
    throw new ManagerToolError('a writable workspace needs isolation "worktree" (or use access "ro" for a direct mount)');
  }
  return repo;
}

/** Manager-created flows: a task repo workspace, a manual trigger and an allowed network mode. */
function checkManagerFlow(task: TaskRecord, def: FlowDefinition): void {
  if (def.workspace.kind !== "local_path") {
    throw new ManagerToolError("the flow workspace must be a local_path inside a task repository");
  }
  checkWorkspace(task, def);
  if (def.trigger.kind !== "manual") throw new ManagerToolError("manager-created flows cannot have a GitHub trigger");
  if (!task.settings.allowNetworkModes.includes(def.sandbox.network.mode)) {
    throw new ManagerToolError(
      `network mode "${def.sandbox.network.mode}" is not allowed for this task (allowed: ${task.settings.allowNetworkModes.join(", ")})`,
    );
  }
}

/** Issue and pull request inputs must point into the task's repos (checked before any GitHub lookup). */
function checkGitHubInputs(task: TaskRecord, def: FlowDefinition, inputs: Record<string, string>): void {
  for (const input of def.inputs) {
    const value = inputs[input.key]?.trim();
    if (!value || input.type === "text") continue;
    const ref = input.type === "github_issue" ? parseIssueUrl(value) : parsePullUrl(value);
    // An unparsable URL is reported by input resolution itself.
    if (ref) assertTaskRepo(task, ref.repo);
  }
}

/**
 * `name` (from GitHub: a default branch, a PR head or base) as an override branch. Names git and GitHub accept
 * but `BranchName` does not (leading `_`, non-ASCII, …) would make the runner drop the `job.assign` and leave
 * the run `assigned` forever, so the tool call fails here instead.
 */
function overrideBranch(name: string, what: string): string {
  if (!isSafeBranch(name)) {
    throw new ManagerToolError(`${what} "${name}" is not a branch name the runner accepts (ASCII letters, digits, . _ / -; starting with a letter or digit)`);
  }
  return name;
}

/**
 * The branch a code run starts from and opens its PR into: `base` when given, else the task's merge mode's. A base
 * the merge mode forbids throws.
 */
function codeRunBase(task: TaskRecord, base: "integration" | "default" | undefined): "integration" | "default" {
  const effective = base ?? (task.settings.merge === "direct" ? "default" : "integration");
  if (task.settings.merge === "direct" && effective === "integration") {
    throw new ManagerToolError('merge mode "direct" forbids base "integration"');
  }
  if (task.settings.merge === "integration" && effective === "default") {
    throw new ManagerToolError('merge mode "integration" forbids base "default"');
  }
  return effective;
}

/** The task's merge mode changed while a start awaited GitHub: what was prepared no longer fits it. */
const MERGE_MODE_CHANGED = "the task's merge mode changed while the run was starting; start it again";

/**
 * Branch/PR overrides for one code run on `repo` (`codeRunBase`), creating the integration branch when needed.
 * `runId` is the calling manager run: the task is re-checked before the branch is created.
 */
async function childOverrides(
  deps: ManagerToolDeps,
  runId: string,
  task: TaskRecord,
  repo: string,
  base: "integration" | "default" | undefined,
): Promise<RunOverrides> {
  const effective = codeRunBase(task, base);
  const t = await deps.credentials.tokenFor(repo, "write");
  if (effective === "default") {
    const def = overrideBranch(await deps.github.getDefaultBranch(t, repo), "default branch");
    return { baseBranch: def, prBase: def };
  }
  const branch = integrationBranch(task.id);
  const existing = await deps.github.getBranchSha(t, repo, branch);
  if (existing === null) {
    const def = await deps.github.getDefaultBranch(t, repo);
    const sha = await deps.github.getBranchSha(t, repo, def);
    if (sha === null) throw new ManagerToolError(`default branch ${def} of ${repo} not found`);
    // After the GitHub reads: an integration branch only for a task that still merges through one.
    if (codeRunBase(taskBeforeWrite(deps, runId, repo), base) !== "integration") throw new ManagerToolError(MERGE_MODE_CHANGED);
    await deps.github.createBranch(t, repo, branch, sha);
  }
  deps.tasks.noteIntegration(task.id, repo, { branch });
  return { baseBranch: branch, prBase: branch };
}

/**
 * Starts one child run. Every `local_path` workspace must be inside a task repo (sent along as
 * `workspaceRoot` for the runner's realpath check) and issue/PR inputs must point into the task's repos. Code
 * runs (writable worktrees) get branch overrides: `merge === "auto"` defaults to the integration branch (picking
 * `base: "default"` for a single-change task is the manager's call). Starts of one task are serialized, so the
 * `maxParallelRuns` check and the insert cannot interleave with another start.
 */
async function startChildRun(
  deps: ManagerToolDeps,
  scope: ManagerScope,
  flow: typeof flows.$inferSelect,
  inputs: Record<string, string>,
  opts: { name?: string; interventions: "manager" | "user" | undefined; base: "integration" | "default" | undefined },
): Promise<string> {
  const { task } = scope;
  if (flow.taskId !== null && flow.taskId !== task.id) throw new ManagerToolError(`flow ${flow.id} not found`);
  checkWorkspace(task, flow.definition);
  checkGitHubInputs(task, flow.definition, inputs);
  const ws = flow.definition.workspace;
  const isCodeRun = ws.kind === "local_path" && ws.isolation === "worktree" && ws.access === "rw";
  /**
   * The checks above against the task as it is now. A queued start waits behind others and on GitHub, and the user
   * may archive or finish the task or change its repos meanwhile: a worker started now would outlive the task, or
   * mount a repo that is no longer the task's (a read-only one never asks for a GitHub token, so nothing else stops it).
   */
  const liveScope = () => {
    const live = authorizeScope(deps, scope.run.id).task;
    const repo = checkWorkspace(live, flow.definition);
    checkGitHubInputs(live, flow.definition, inputs);
    return { live, repo };
  };
  return deps.tasks.serializeChildStart(task.id, async () => {
    const { live, repo } = liveScope();
    assertChildCapacity(deps, live);
    // The base the overrides are built for; the final check below compares it against the task as it is then.
    const base = isCodeRun ? codeRunBase(live, opts.base) : null;
    const overrides: RunOverrides | undefined =
      repo === null
        ? undefined
        : { workspaceRoot: repo.localPath, ...(isCodeRun ? await childOverrides(deps, scope.run.id, live, repo.github, opts.base) : {}) };
    const started = await startRun(
      deps,
      { id: flow.id, version: flow.version, definition: flow.definition },
      {
        inputs,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        createdBy: live.createdBy,
        task: {
          taskId: live.id,
          role: "worker",
          interventionHandler: opts.interventions ?? live.settings.interventions,
          ...(overrides !== undefined ? { overrides } : {}),
          // Again after awaiting GitHub (overrides, inputs), right before the run exists: `workspaceRoot` must still
          // be the clone of a repo of the task, and a code run's base still the one its merge mode allows.
          authorize: () => {
            const now = liveScope();
            if (now.repo?.localPath !== repo?.localPath) {
              throw new ManagerToolError("the task's repositories changed while the run was starting; start it again");
            }
            if (base !== null && codeRunBase(now.live, opts.base) !== base) throw new ManagerToolError(MERGE_MODE_CHANGED);
          },
        },
      },
    );
    if (!started.ok) throw new ManagerToolError(opErrorMessage(started));
    console.log(`[manager] task ${task.id}: started child run ${started.runId} of flow ${flow.id}`);
    deps.tasks.publishRun(task.id, started.runId);
    return started.runId;
  });
}

/** Truncated child-run summary for `list_runs` (and the base of `get_run`). */
function childSummary(deps: ManagerToolDeps, r: RunRecord): Record<string, unknown> {
  const prs = childPrUrls(deps.tasks.db, r);
  return {
    runId: r.id,
    name: r.name ?? r.definition.name,
    flowId: r.flowId,
    status: r.status,
    interventionHandler: r.interventionHandler,
    ...(prs.length > 0 ? { prs } : {}),
    ...(r.error !== null ? { error: runText(r, r.error) } : {}),
  };
}

/** Full child-run detail: every step with a truncated output. */
function runDetail(deps: ManagerToolDeps, r: RunRecord): Record<string, unknown> {
  const steps = deps.tasks.db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, r.id))
    .orderBy(asc(runSteps.idx))
    .all()
    .map((s) => ({
      stepId: s.stepId,
      name: r.definition.steps.find((st) => st.id === s.stepId)?.name ?? s.stepId,
      status: s.status,
      ...(s.output === null ? {} : { output: runText(r, s.output) }),
    }));
  return { ...childSummary(deps, r), steps };
}

/** PR state read with a `status` token (pull requests + checks + statuses read). */
async function pullStatus(deps: ManagerToolDeps, repo: string, number: number) {
  const t = await deps.credentials.tokenFor(repo, "status");
  return deps.github.getPullStatus(t, repo, number);
}

/** The task's entry for repo `owner/name` (its canonical casing keys `tasks.integration`), or forbidden. */
function taskRepo(task: TaskRecord, repo: string): TaskRecord["settings"]["repos"][number] {
  const entry = task.settings.repos.find((r) => sameRepo(r.github, repo));
  if (!entry) throw new ManagerToolError(`repository ${repo} is not part of this task`);
  return entry;
}

/**
 * Squash-merges one orchestrator PR (head `orch/*` in the same repo) into the task's integration branch.
 * PRs into the default branch (the final PR, or a direct-mode worker PR) only with `autoMergeFinal`.
 */
async function mergePr(deps: ManagerToolDeps, scope: ManagerScope, repo: string, number: number): Promise<unknown> {
  const { task } = scope;
  const { github } = taskRepo(task, repo);
  const pr = await pullStatus(deps, github, number);
  if (!isOrchBranch(pr.head.ref) || pr.head.repo === null || !sameRepo(pr.head.repo, github)) {
    throw new ManagerToolError("only orchestrator PRs (head branch orch/*) can be merged");
  }
  assertTaskPr(deps, task, github, number);
  const t = await deps.credentials.tokenFor(github, "write");
  const integration = integrationBranch(task.id);
  const defaultBranch = await deps.github.getDefaultBranch(t, github);
  // After the GitHub reads, right before the merge: the task as it is now decides (status, repo, autoMergeFinal).
  const live = taskBeforeWrite(deps, scope.run.id, github);
  if (pr.base.ref === defaultBranch) {
    if (!live.settings.autoMergeFinal) throw new ManagerToolError("merging into the default branch requires the autoMergeFinal setting");
  } else if (pr.base.ref !== integration) {
    throw new ManagerToolError(`PR base must be the task integration branch ${integration}`);
  }
  if (pr.merged) return { merged: true, alreadyMerged: true };
  if (pr.state !== "open") throw new ManagerToolError(`PR ${github}#${number} is closed`);
  try {
    // `sha` pins the reviewed head: a push after `get_pr_status` makes GitHub refuse instead of merging unseen commits.
    const merged = await deps.github.mergePullRequest(t, github, number, { method: "squash", sha: pr.head.sha });
    console.log(`[manager] task ${task.id}: merged PR ${github}#${number}`);
    return { merged: true, sha: merged.sha };
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 405 || err.status === 409)) {
      return { merged: false, mergeableState: pr.mergeableState, reason: err.message };
    }
    throw err;
  }
}

/**
 * PR `repo#number` belongs to this task: its recorded final PR, or the PR a `github_pr` step of one of its own
 * worker runs opened. `orch/*` alone is not enough: every task (and the user) shares that prefix in a repo, and
 * merging or force-pushing (resolve-conflicts) another task's PR would reach outside this task.
 */
function assertTaskPr(deps: ManagerToolDeps, task: TaskRecord, repo: string, number: number): void {
  if (task.integration[repo]?.finalPr?.number === number) return;
  const workers = deps.tasks.db.select().from(runs).where(and(eq(runs.taskId, task.id), eq(runs.role, "worker"))).all();
  for (const w of workers) {
    for (const url of childPrUrls(deps.tasks.db, w)) {
      const ref = parsePullUrl(url);
      if (ref !== null && sameRepo(ref.repo, repo) && ref.number === number) return;
    }
  }
  throw new ManagerToolError(`PR ${repo}#${number} was not opened by this task`);
}

/** Starts the built-in resolve-conflicts run on one orchestrator PR (head `orch/*` in the same repo). */
async function resolveConflicts(deps: ManagerToolDeps, scope: ManagerScope, repo: string, number: number): Promise<unknown> {
  const { task } = scope;
  const entry = taskRepo(task, repo);
  const pr = await pullStatus(deps, entry.github, number);
  if (!isOrchBranch(pr.head.ref) || pr.head.repo === null || !sameRepo(pr.head.repo, entry.github)) {
    throw new ManagerToolError("only orchestrator PRs (head branch orch/*) can be resolved");
  }
  if (pr.state !== "open" || pr.merged) throw new ManagerToolError(`PR ${entry.github}#${number} is not open`);
  assertTaskPr(deps, task, entry.github, number);
  const definition = resolveConflictsDefinition(entry.localPath, task.settings.managerModels);
  const head = overrideBranch(pr.head.ref, "PR head branch");
  const base = overrideBranch(pr.base.ref, "PR base branch");
  // The worktree starts from the PR head, the base is fetched to rebase onto, and the push goes back to the
  // head branch with a lease on the fetched head (`orch/*` only, re-checked by the runner).
  const overrides: RunOverrides = {
    workspaceRoot: entry.localPath,
    baseBranch: head,
    fetchBranches: [base],
    pushBranch: head,
    forcePush: true,
  };
  return deps.tasks.serializeChildStart(task.id, async () => {
    // Re-authorized inside the queue (see `startChildRun`), and again right before the run exists.
    const live = authorizeScope(deps, scope.run.id).task;
    assertChildCapacity(deps, live);
    const started = await startRun(
      deps,
      { id: RESOLVE_CONFLICTS_FLOW_ID, version: 1, definition },
      {
        inputs: { pr_url: pr.url, head, base, onto: fetchedBranchRef(base) },
        name: `Resolve conflicts: ${entry.github}#${number}`,
        createdBy: live.createdBy,
        task: {
          taskId: live.id,
          role: "worker",
          interventionHandler: live.settings.interventions,
          overrides,
          authorize: () => {
            const now = authorizeScope(deps, scope.run.id).task;
            if (taskRepo(now, entry.github).localPath !== entry.localPath) {
              throw new ManagerToolError("the task's repositories changed while the run was starting; start it again");
            }
          },
        },
      },
    );
    if (!started.ok) throw new ManagerToolError(opErrorMessage(started));
    console.log(`[manager] task ${task.id}: resolve-conflicts run ${started.runId} for PR ${entry.github}#${number}`);
    deps.tasks.publishRun(task.id, started.runId);
    return { runId: started.runId };
  });
}

/**
 * Opens (once) the final PR from the task's integration branch into the default branch. Merges into a
 * non-default branch close no issues, so the final PR carries one `Closes #n` line per issue.
 */
async function openFinalPr(
  deps: ManagerToolDeps,
  scope: ManagerScope,
  repo: string,
  title: string,
  body: string,
  closes: number[],
): Promise<unknown> {
  const { task } = scope;
  const { github } = taskRepo(task, repo);
  const integration = task.integration[github];
  if (!integration) throw new ManagerToolError(`${github} has no integration branch yet: no code run started there`);
  if (integration.finalPr) return integration.finalPr;
  const t = await deps.credentials.tokenFor(github, "write");
  const def = await deps.github.getDefaultBranch(t, github);
  const open = await deps.github.findOpenPull(t, github, integration.branch, def);
  if (open) {
    deps.tasks.noteIntegration(task.id, github, { branch: integration.branch, finalPr: open });
    return open;
  }
  // After the GitHub reads, right before the PR is opened: the task as it is now (another call may have opened it).
  const recorded = taskBeforeWrite(deps, scope.run.id, github).integration[github]?.finalPr;
  if (recorded) return recorded;
  const closesLines = [...new Set(closes)].map((n) => `Closes #${n}`).join("\n");
  const created = await deps.github.createPullRequest(t, {
    repo: github,
    head: integration.branch,
    base: def,
    title: neutralizeMentions(title, 256),
    body: neutralizeMentions(closesLines ? `${body}\n\n${closesLines}` : body, GH_BODY_MAX),
    draft: false,
  });
  deps.tasks.noteIntegration(task.id, github, { branch: integration.branch, finalPr: created });
  console.log(`[manager] task ${task.id}: opened final PR ${github}#${created.number}`);
  return created;
}

/**
 * Dispatches one validated `ManagerToolCall` for the manager run `runId`. Throws
 * `ManagerToolError` on authorization failures and tool errors; the caller turns those into
 * `ok:false` RPC results, which the runner hands to the agent as an error tool result.
 */
export async function dispatchManagerTool(deps: ManagerToolDeps, runId: string, call: ManagerToolCall): Promise<unknown> {
  const scope = authorizeScope(deps, runId);
  const { task } = scope;
  const db = deps.tasks.db;
  switch (call.name) {
    // ---- Flows -----------------------------------------------------------------------------------
    case "list_flows": {
      // Only flows the manager could start: its own and user flows on a task repo (or PR checkouts).
      return db
        .select()
        .from(flows)
        .all()
        .filter((f) => flowInScope(task, f))
        .map((f) => ({
          flowId: f.id,
          name: f.name,
          version: f.version,
          origin: f.origin,
          inputs: f.definition.inputs.map((i) => ({ key: i.key, label: i.label, type: i.type, required: i.required })),
          workspace: f.definition.workspace,
          steps: f.definition.steps.map((s) => `${s.id} (${s.kind})`),
        }));
    }
    case "get_flow": {
      // Same scope as `list_flows`: a flow on some other path is not the task's business, even by id.
      const f = db.select().from(flows).where(eq(flows.id, call.args.flowId)).get();
      if (!f || !flowInScope(task, f)) throw new ManagerToolError(`flow ${call.args.flowId} not found`);
      return f.definition;
    }
    case "validate_flow": {
      const v = validateFlow(call.args.definition);
      return v.ok ? { ok: true, errors: [] } : { ok: false, errors: v.errors };
    }
    case "create_flow": {
      const v = validateFlow(call.args.definition);
      if (!v.ok) throw new ManagerToolError(v.errors.join("; "));
      checkManagerFlow(task, v.flow);
      const now = Date.now();
      const id = ulid();
      db.insert(flows)
        .values({ id, name: v.flow.name, definition: v.flow, version: 1, createdAt: now, updatedAt: now, taskId: task.id, origin: "manager" })
        .run();
      console.log(`[manager] task ${task.id}: created flow ${id} (${v.flow.name})`);
      return { flowId: id, name: v.flow.name };
    }
    // ---- Child runs ------------------------------------------------------------------------------
    case "start_run": {
      const flow = db.select().from(flows).where(eq(flows.id, call.args.flowId)).get();
      if (!flow) throw new ManagerToolError(`flow ${call.args.flowId} not found`);
      const runId = await startChildRun(deps, scope, flow, call.args.inputs ?? {}, {
        ...(call.args.name !== undefined ? { name: call.args.name } : {}),
        interventions: call.args.interventions,
        base: call.args.base,
      });
      return { runId };
    }
    case "list_runs": {
      return deps.tasks
        .taskRuns(task.id)
        .filter((r) => r.role === "worker")
        .flatMap((r) => {
          const record = deps.tasks.run(r.id);
          return record ? [childSummary(deps, record)] : [];
        });
    }
    case "get_run": {
      return runDetail(deps, childRun(deps, scope, call.args.runId));
    }
    case "respond_intervention": {
      const child = childRun(deps, scope, call.args.runId);
      if (child.interventionHandler !== "manager") throw new ManagerToolError("this run's interventions are answered by the user");
      const out = respondIntervention(deps, child.id, call.args.requestId, {
        stepId: call.args.stepId,
        action: call.args.action,
        ...(call.args.session !== undefined ? { session: call.args.session } : {}),
        ...(call.args.text !== undefined ? { text: call.args.text } : {}),
        ...(call.args.choice !== undefined ? { choice: call.args.choice } : {}),
      });
      if (!out.ok) throw new ManagerToolError(opErrorMessage(out));
      return { ok: true };
    }
    case "respond_permission": {
      const child = childRun(deps, scope, call.args.runId);
      if (child.interventionHandler !== "manager") throw new ManagerToolError("this run's permission requests are answered by the user");
      const out = respondPermission(deps, child.id, call.args.requestId, call.args.optionId);
      if (!out.ok) throw new ManagerToolError(opErrorMessage(out));
      return { ok: true };
    }
    case "cancel_run": {
      const child = childRun(deps, scope, call.args.runId);
      const out = cancelRun(deps, child.id);
      if (!out.ok) throw new ManagerToolError(opErrorMessage(out));
      return { ok: true };
    }
    case "retry_run": {
      const child = childRun(deps, scope, call.args.runId);
      // A retry makes a terminal child non-terminal again: same serialized `maxParallelRuns` check as a start.
      return deps.tasks.serializeChildStart(task.id, async () => {
        // Re-authorized inside the queue (see `startChildRun`): a finished or archived task takes no more runs.
        const live = authorizeScope(deps, scope.run.id).task;
        assertChildCapacity(deps, live);
        // The retry reuses the stored definition and overrides: its workspace must still be inside a repo of the
        // task, and the clone it mounts (`workspaceRoot`) still that repo's. A read-only child asks for no GitHub
        // token, so nothing else would stop it from mounting a repo the user removed from the task.
        const repo = checkWorkspace(live, child.definition);
        if ((child.overrides?.workspaceRoot ?? null) !== (repo?.localPath ?? null)) {
          throw new ManagerToolError("the task's repositories changed since this run started; start a new run instead");
        }
        const out = retryRun(deps, child.id, call.args.fromStepId);
        if (!out.ok) throw new ManagerToolError(opErrorMessage(out));
        return { ok: true };
      });
    }
    // ---- GitHub ----------------------------------------------------------------------------------
    case "create_issue": {
      assertTaskRepo(task, call.args.repo);
      const t = await deps.credentials.tokenFor(call.args.repo, "comment");
      taskBeforeWrite(deps, scope.run.id, call.args.repo);
      const issue = await deps.github.createIssue(t, call.args.repo, {
        title: neutralizeMentions(call.args.title, 256),
        body: neutralizeMentions(call.args.body, GH_BODY_MAX),
      });
      return { url: issue.url, number: issue.number };
    }
    case "get_issue": {
      assertTaskRepo(task, call.args.repo);
      const t = await deps.credentials.tokenFor(call.args.repo, "read");
      const ref = parseIssueUrl(`https://github.com/${call.args.repo}/issues/${call.args.number}`);
      if (!ref) throw new ManagerToolError(`invalid issue ${call.args.repo}#${call.args.number}`);
      const issue = await deps.github.getIssue(ref, t);
      // Issue text is repository data (anyone can file issues): wrapped, delimiters neutralised.
      return { url: issue.url, number: issue.number, title: wrapUntrustedData(issue.title), body: wrapUntrustedData(issue.body) };
    }
    case "comment_issue": {
      const { github } = taskRepo(task, call.args.repo);
      // PR conversations take pull_requests write (the `report` token), issues need issues write (`comment`),
      // as for `github_comment` steps: an App's issues-only token cannot comment on a pull request.
      const isPr = await deps.github.isPullRequest(await deps.credentials.tokenFor(github, "read"), github, call.args.number);
      const t = await deps.credentials.tokenFor(github, isPr ? "report" : "comment");
      taskBeforeWrite(deps, scope.run.id, github);
      return deps.github.createIssueComment(t, github, call.args.number, neutralizeMentions(call.args.body, GH_BODY_MAX));
    }
    case "get_pr_status": {
      const status = await pullStatus(deps, taskRepo(task, call.args.repo).github, call.args.number);
      // Check-run names and status contexts come from the PR's workflows, which an untrusted PR can set: data for
      // the manager, never instructions. Only this tool's result is wrapped; merge_pr and resolve_conflicts read the raw names.
      const checks = status.checks;
      return {
        ...status,
        checks: { ...checks, failing: checks.failing.map((n) => wrapUntrustedData(n)), pending: checks.pending.map((n) => wrapUntrustedData(n)) },
      };
    }
    case "merge_pr": {
      return mergePr(deps, scope, call.args.repo, call.args.number);
    }
    case "resolve_conflicts": {
      return resolveConflicts(deps, scope, call.args.repo, call.args.number);
    }
    case "open_final_pr": {
      return openFinalPr(deps, scope, call.args.repo, call.args.title, call.args.body, call.args.closes);
    }
    // ---- Task chat -------------------------------------------------------------------------------
    case "ask_user": {
      const message = deps.tasks.append({
        taskId: task.id,
        role: "manager",
        text: call.args.question,
        ...(call.args.choices !== undefined ? { choices: call.args.choices } : {}),
      });
      deps.tasks.setNeedsInput(task.id);
      return { seq: message.seq };
    }
    case "complete_task": {
      deps.tasks.append({ taskId: task.id, role: "manager", text: call.args.summary });
      deps.tasks.setDone(task.id);
      return { ok: true };
    }
  }
}

/** The branch name is an orchestrator branch (`orch/*`). */
function isOrchBranch(ref: string): boolean {
  return ref.startsWith(ORCH_BRANCH_PREFIX);
}
