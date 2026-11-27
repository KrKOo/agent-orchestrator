// Tasks: a chat with a long-lived manager agent that plans work and drives child runs (issue #34).
// The manager never implements anything itself: its workspace is read-only and every change it makes
// goes through the scoped manager tools below (MCP in the sandbox → `manager.tool` RPC → server).
import { z } from "zod";
import {
  HarnessModels,
  harnessModelErrors,
  INTERVENTION_MESSAGE_ISSUE,
  InterventionAnswer,
  InterventionChoice,
  interventionMessageValid,
  REPO_RE,
  wrapUntrustedText,
} from "./flow";

/** `needs_input`: the manager asked the user something (`ask_user`) or stopped; `done`: completed by the manager or user. */
export const TASK_STATUSES = ["active", "needs_input", "done", "archived"] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Max task title length (UTF-16 code units). */
export const TASK_TITLE_MAX = 200;
/** Max length of one chat message the user posts. */
export const TASK_MESSAGE_MAX = 20_000;

/**
 * A plain git branch name we are willing to put into git argv and refspecs: no `..`, `//`, leading `-`/`/`,
 * trailing `/` or `.lock`, and only `[A-Za-z0-9._/-]`.
 */
export function isSafeBranch(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    name.length <= 200
  );
}
export const BranchName = z.string().refine(isSafeBranch, "invalid branch name");

/** Prefix of every branch the orchestrator owns; the only branches it merges from or force-pushes. */
export const ORCH_BRANCH_PREFIX = "orch/";

/**
 * The integration branch of task `taskId` (one per task and repo, same name in every repo). The whole lowercased
 * ULID: its first 10 characters are only the creation millisecond, so a prefix could be shared by two tasks.
 */
export function integrationBranch(taskId: string): string {
  return `${ORCH_BRANCH_PREFIX}task-${taskId.toLowerCase()}`;
}

export const TaskRepo = z.object({
  /** GitHub repository `owner/name`. */
  github: z.string().regex(REPO_RE, 'github must be "owner/name"'),
  /** Absolute host path of the local clone on the task owner's runner (must be under its `allowedRoots`). */
  localPath: z.string().refine((p) => p.startsWith("/"), "localPath must be absolute"),
});
export type TaskRepo = z.infer<typeof TaskRepo>;

export const NetworkMode = z.enum(["gateway_only", "allowlist", "open"]);

export const TaskSettings = z.object({
  /** Repositories the task may touch; the first one is the manager's (read-only) workspace. */
  repos: z.array(TaskRepo).min(1, "list at least one repository").max(10),
  /** Who answers child runs' interventions and permission requests by default. */
  interventions: z.enum(["manager", "user"]).default("manager"),
  /**
   * `integration`: workers PR into the task's integration branch, the manager merges those and opens one final PR.
   * `direct`: worker PRs go to the default branch. `auto`: the manager picks per `start_run` (`base`).
   */
  merge: z.enum(["auto", "integration", "direct"]).default("auto"),
  /** Let the manager merge PRs into the default branch (the final PR). Off: the user merges it. */
  autoMergeFinal: z.boolean().default(false),
  /**
   * Models of the manager agent (also used by the built-in resolve-conflicts flow). Checked like a flow's
   * `harness` models here, so invalid roles are a 400 on the task, not a failure to start its manager.
   */
  managerModels: HarnessModels.superRefine((models, ctx) => {
    for (const message of harnessModelErrors(models, "")) ctx.addIssue({ code: "custom", message });
  }),
  /** Network modes flows the manager creates may use. */
  allowNetworkModes: z.array(NetworkMode).min(1).default(["gateway_only", "allowlist"]),
  /** Child runs of the task that may be non-terminal at once. */
  maxParallelRuns: z.number().int().min(1).max(20).default(3),
});
export type TaskSettings = z.infer<typeof TaskSettings>;
export type TaskSettingsInput = z.input<typeof TaskSettings>;

/** Per task repo (`owner/name`): its integration branch once created, and the final PR once opened. */
export const TaskIntegration = z.record(
  z.string(),
  z.object({ branch: z.string(), finalPr: z.object({ number: z.number().int(), url: z.string() }).optional() }),
);
export type TaskIntegration = z.infer<typeof TaskIntegration>;

/**
 * What an `event` message reports: a child run finished, waits on an intervention or permission the manager
 * handles, or waits on the user (FYI); `note`: anything else the server tells the manager.
 */
export const TaskEventKind = z.enum(["run_finished", "intervention", "permission", "awaiting_user", "note"]);
export type TaskEventKind = z.infer<typeof TaskEventKind>;

/**
 * One entry of a task's chat log, which is also the manager's inbox: `user` and `event` messages with
 * `seq > tasks.inboxAckedSeq` are not consumed yet. `manager` messages are its replies and `ask_user` questions.
 */
export const TaskMessage = z.object({
  taskId: z.string(),
  seq: z.number().int().min(1),
  role: z.enum(["user", "manager", "event"]),
  /** Event text from untrusted child runs carries its untrusted parts wrapped in `<untrusted_pr_text>`. */
  text: z.string(),
  ts: z.number(),
  /** `event`: the child run it is about. */
  runId: z.string().optional(),
  event: TaskEventKind.optional(),
  /** `manager` question (`ask_user`): buttons the user can answer with. */
  choices: z.array(InterventionChoice).optional(),
  /** `user`: the picked choice id, answering question `answerTo` (its seq). */
  choice: z.string().optional(),
  answerTo: z.number().int().min(1).optional(),
});
export type TaskMessage = z.infer<typeof TaskMessage>;

/**
 * Sent with a manager run's `job.assign`: the manager's first prompt is its step prompt (the system prompt)
 * followed by `brief`, the server-rendered state of the task (settings, child runs ledger, chat history up to
 * the consumed seq). Agent sessions never resume, so this is how a restarted manager picks up where it left off.
 */
export const ManagerContext = z.object({ taskId: z.string(), title: z.string(), brief: z.string() });
export type ManagerContext = z.infer<typeof ManagerContext>;

/**
 * Per-run workspace and push overrides the server sets on task child runs; flow definitions stay unchanged.
 * Only valid for owner runs with a `local_path` workspace; the branch fields need worktree isolation. Remote
 * branches are fetched on the host (never in the sandbox) into `refs/orch/remote/<branch>`, so the user's
 * remote-tracking refs are untouched.
 */
export const RunOverrides = z.object({
  /**
   * The task repo clone the workspace must stay inside. The server checks the path lexically; the runner
   * re-checks the realpathed workspace against the realpathed root, so symlinks cannot leave the task's repos.
   */
  workspaceRoot: z.string().refine((p) => p.startsWith("/"), "workspaceRoot must be absolute").optional(),
  /** Remote branch the worktree starts from instead of `workspace.baseRef`. */
  baseBranch: BranchName.optional(),
  /** More remote branches fetched for the agent (e.g. the rebase target of resolve-conflicts). */
  fetchBranches: z.array(BranchName).max(4).optional(),
  /** Remote branch `git_push` pushes to (and `github_pr` opens from) instead of the worktree branch. */
  pushBranch: BranchName.optional(),
  /** `git_push` uses `--force-with-lease` against the push target as this run fetched it; `orch/*` only. */
  forcePush: z.boolean().optional(),
  /** Base branch of `github_pr` steps instead of the step's `base`. */
  prBase: BranchName.optional(),
});
export type RunOverrides = z.infer<typeof RunOverrides>;

/** True when `ov` changes branches (start point, fetches, push or PR target), which needs a worktree. */
export function hasBranchOverrides(ov: RunOverrides): boolean {
  return (
    ov.baseBranch !== undefined ||
    (ov.fetchBranches?.length ?? 0) > 0 ||
    ov.pushBranch !== undefined ||
    ov.forcePush === true ||
    ov.prBase !== undefined
  );
}

/** Host ref a fetched remote branch lands in (see `RunOverrides`). */
export function fetchedBranchRef(branch: string): string {
  return `refs/orch/remote/${branch}`;
}

/**
 * Flow ids of the server's built-in flows (`builtin:manager`, `builtin:resolve-conflicts`): built per run, never
 * stored in `flows`, so there is no flow page to link to.
 */
export function isBuiltinFlowId(flowId: string): boolean {
  return flowId.startsWith("builtin:");
}

/** Tag that wraps one inbox event in the manager's prompt (`renderInbox` on the runner). */
export const ORCH_EVENT_TAG = "orch_event";

/**
 * Neutralises opening and closing `tags` inside text that is about to be wrapped in one of them: `<` becomes
 * `&lt;`, so text like `</orch_event>` stays visible but can no longer end its wrapper and pass what follows off
 * as trusted prompt text.
 */
export function escapeTags(text: string, tags: readonly string[]): string {
  return text.replace(new RegExp(`<(\\s*/?\\s*)(${tags.join("|")})`, "gi"), "&lt;$1$2");
}

/**
 * Wraps untrusted data quoted to the manager (child run output, issue text): `wrapUntrustedText` after
 * neutralising both wrappers it sits in, `<untrusted_pr_text>` and the inbox's `<orch_event>`.
 */
export function wrapUntrustedData(text: string): string {
  return wrapUntrustedText(escapeTags(text, ["untrusted_pr_text", ORCH_EVENT_TAG]));
}

// ---- Manager tools ------------------------------------------------------------------------------

const RepoName = z.string().regex(REPO_RE, 'repo must be "owner/name"');
const IssueNumber = z.number().int().min(1);

/**
 * Argument schemas per manager tool. The runner registers each as an MCP tool (`args.shape` is the input
 * schema); the server dispatches the validated `ManagerToolCall`. Every tool is authorized server-side
 * against the calling manager's task: child runs of the task only, the task's repos only.
 */
export const MANAGER_TOOL_ARGS = {
  list_flows: z.object({}),
  get_flow: z.object({ flowId: z.string().min(1) }),
  validate_flow: z.object({ definition: z.record(z.string(), z.unknown()).describe("Flow definition JSON") }),
  create_flow: z.object({ definition: z.record(z.string(), z.unknown()).describe("Flow definition JSON") }),
  start_run: z.object({
    flowId: z.string().min(1),
    inputs: z.record(z.string(), z.string()).optional().describe("Flow inputs by key (issue/PR inputs take URLs)"),
    name: z.string().min(1).max(120).optional().describe("Short display name of the run"),
    interventions: z.enum(["manager", "user"]).optional().describe("Who answers the run's interventions; defaults to the task setting"),
    base: z
      .enum(["integration", "default"])
      .optional()
      .describe("Branch code runs start from and open PRs into: the task integration branch or the default branch"),
  }),
  list_runs: z.object({}),
  get_run: z.object({ runId: z.string().min(1) }),
  respond_intervention: InterventionAnswer.extend({ runId: z.string().min(1), requestId: z.string().min(1) }).refine(
    interventionMessageValid,
    INTERVENTION_MESSAGE_ISSUE,
  ),
  respond_permission: z.object({ runId: z.string().min(1), requestId: z.string().min(1), optionId: z.string().min(1).nullable() }),
  cancel_run: z.object({ runId: z.string().min(1) }),
  retry_run: z.object({ runId: z.string().min(1), fromStepId: z.string().min(1).optional() }),
  create_issue: z.object({ repo: RepoName, title: z.string().min(1).max(256), body: z.string().max(60_000) }),
  get_issue: z.object({ repo: RepoName, number: IssueNumber }),
  comment_issue: z.object({ repo: RepoName, number: IssueNumber, body: z.string().min(1).max(60_000) }),
  get_pr_status: z.object({ repo: RepoName, number: IssueNumber }),
  merge_pr: z.object({ repo: RepoName, number: IssueNumber }),
  resolve_conflicts: z.object({ repo: RepoName, number: IssueNumber }),
  open_final_pr: z.object({
    repo: RepoName,
    title: z.string().min(1).max(256),
    body: z.string().max(60_000),
    closes: z.array(IssueNumber).max(100).default([]).describe("Issue numbers the final PR closes"),
  }),
  ask_user: z.object({
    question: z.string().min(1).max(TASK_MESSAGE_MAX),
    choices: z.array(InterventionChoice).min(2).max(8).optional(),
  }),
  complete_task: z.object({ summary: z.string().min(1).max(TASK_MESSAGE_MAX) }),
} as const;

export type ManagerToolName = keyof typeof MANAGER_TOOL_ARGS;
export const MANAGER_TOOL_NAMES = Object.keys(MANAGER_TOOL_ARGS) as ManagerToolName[];

export const MANAGER_TOOL_DESCRIPTIONS: Record<ManagerToolName, string> = {
  list_flows: "List the flows you can start: the user's flows and the ones this task created (id, name, inputs, workspace).",
  get_flow: "Get one flow's full definition.",
  validate_flow: "Validate a flow definition without saving it; returns the errors.",
  create_flow:
    "Save a new flow for this task. Its workspace must be one of the task repositories; it cannot have a GitHub trigger.",
  start_run:
    "Start a child run of a flow. Code-changing runs (worktree workspaces) start from and open PRs into the task integration branch (base: integration) or the default branch (base: default).",
  list_runs: "List this task's child runs with status, PR links and errors.",
  get_run: "Get one child run with its step statuses and (truncated) outputs.",
  respond_intervention:
    "Answer a child run's intervention: message (chat with a session), continue (with choice on gates with choices), repeat (ask loops) or cancel.",
  respond_permission: "Answer a child run's permission request with one of its option ids (null rejects).",
  cancel_run: "Cancel a child run.",
  retry_run: "Retry a failed or cancelled child run, from its first unfinished step or from fromStepId.",
  create_issue: "Create a GitHub issue in a task repository.",
  get_issue: "Read a GitHub issue of a task repository.",
  comment_issue: "Comment on an issue or pull request of a task repository.",
  get_pr_status: "Pull request state: mergeable, mergeable_state, head/base branches and check results.",
  merge_pr: "Squash-merge an orchestrator PR (head orch/*) into the task integration branch.",
  resolve_conflicts:
    "Start the built-in resolve-conflicts run on an orchestrator PR: rebases its branch onto the PR base, resolves conflicts, runs checks and force-pushes.",
  open_final_pr:
    "Open (once) the final PR from the task integration branch into the default branch; lists Closes #n for each issue.",
  ask_user: "Ask the user a question (optionally with choice buttons). Their answer arrives as a user message.",
  complete_task: "Mark the task done with a short summary for the user.",
};

export const ManagerToolCall = z.discriminatedUnion("name", [
  z.object({ name: z.literal("list_flows"), args: MANAGER_TOOL_ARGS.list_flows }),
  z.object({ name: z.literal("get_flow"), args: MANAGER_TOOL_ARGS.get_flow }),
  z.object({ name: z.literal("validate_flow"), args: MANAGER_TOOL_ARGS.validate_flow }),
  z.object({ name: z.literal("create_flow"), args: MANAGER_TOOL_ARGS.create_flow }),
  z.object({ name: z.literal("start_run"), args: MANAGER_TOOL_ARGS.start_run }),
  z.object({ name: z.literal("list_runs"), args: MANAGER_TOOL_ARGS.list_runs }),
  z.object({ name: z.literal("get_run"), args: MANAGER_TOOL_ARGS.get_run }),
  z.object({ name: z.literal("respond_intervention"), args: MANAGER_TOOL_ARGS.respond_intervention }),
  z.object({ name: z.literal("respond_permission"), args: MANAGER_TOOL_ARGS.respond_permission }),
  z.object({ name: z.literal("cancel_run"), args: MANAGER_TOOL_ARGS.cancel_run }),
  z.object({ name: z.literal("retry_run"), args: MANAGER_TOOL_ARGS.retry_run }),
  z.object({ name: z.literal("create_issue"), args: MANAGER_TOOL_ARGS.create_issue }),
  z.object({ name: z.literal("get_issue"), args: MANAGER_TOOL_ARGS.get_issue }),
  z.object({ name: z.literal("comment_issue"), args: MANAGER_TOOL_ARGS.comment_issue }),
  z.object({ name: z.literal("get_pr_status"), args: MANAGER_TOOL_ARGS.get_pr_status }),
  z.object({ name: z.literal("merge_pr"), args: MANAGER_TOOL_ARGS.merge_pr }),
  z.object({ name: z.literal("resolve_conflicts"), args: MANAGER_TOOL_ARGS.resolve_conflicts }),
  z.object({ name: z.literal("open_final_pr"), args: MANAGER_TOOL_ARGS.open_final_pr }),
  z.object({ name: z.literal("ask_user"), args: MANAGER_TOOL_ARGS.ask_user }),
  z.object({ name: z.literal("complete_task"), args: MANAGER_TOOL_ARGS.complete_task }),
]);
export type ManagerToolCall = z.infer<typeof ManagerToolCall>;
export type ManagerToolCallOf<N extends ManagerToolName> = Extract<ManagerToolCall, { name: N }>;
