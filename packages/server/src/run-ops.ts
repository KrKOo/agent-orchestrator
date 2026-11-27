// Run operations shared by the REST handlers (`api/runs.ts`) and the manager tools: one convention
// for creating, cancelling, retrying and answering runs, so both paths validate identically.
import {
  type ElicitationAction,
  type FlowDefinition,
  type GitHubIssueInput,
  type InputDef,
  InterventionAction,
  type PullRequestInput,
  type RunOverrides,
} from "@orch/protocol";
import { eq } from "drizzle-orm";
import { initialPullRunStatus, insertRun, pullRequestInput } from "./createRun";
import { schema } from "./db";
import type { AppDeps } from "./deps";
import { GitHubError, parseIssueUrl, parsePullUrl } from "./github/api";
import { isTerminal } from "./runs";

const { runSteps } = schema;

/** Operation result for REST/manager tools: an HTTP-shaped error, or `ok` plus op-specific data. */
export type OpError = { ok: false; status: 400 | 403 | 404 | 409 | 502; body: { error: string } | { errors: string[] } };
export type Op<T extends object = {}> = ({ ok: true } & T) | OpError;

export interface TaskRunOrigin {
  taskId: string;
  role: "manager" | "worker";
  /** Task child runs: who answers interventions and permission requests. */
  interventionHandler?: "user" | "manager";
  /** Task child runs: workspace/push overrides sent with `job.assign`. */
  overrides?: RunOverrides;
  /**
   * Task child runs: re-checks the task right before the run row is inserted (input resolution awaits GitHub, and
   * the task may be archived or finished meanwhile); throwing aborts the start.
   */
  authorize?: () => void;
}

export interface StartRunOptions {
  inputs: Record<string, string>;
  name?: string;
  autoName?: boolean;
  createdBy: string | null;
  task?: TaskRunOrigin;
}

export type InputResolution =
  | { ok: true; inputs: Record<string, unknown>; untrustedPullSource: boolean }
  | { ok: false; status: 400 | 502; body: { error: string } | { errors: string[] } };

/**
 * Checks raw string inputs against the flow's `InputDef`s and resolves `github_issue` and
 * `github_pull_request` URLs. Optional inputs left empty become `""` (text) or `null` (GitHub inputs).
 * `untrustedPullSource` reports a fork or first-time-contributor pull request input.
 */
export async function resolveInputs(
  deps: Pick<AppDeps, "credentials" | "github">,
  defs: InputDef[],
  raw: Record<string, string>,
): Promise<InputResolution> {
  const errors: string[] = [];
  const declared = new Set(defs.map((d) => d.key));
  for (const key of Object.keys(raw)) if (!declared.has(key)) errors.push(`inputs.${key}: not declared by the flow`);
  for (const d of defs) {
    if (d.required && !(raw[d.key] ?? "").trim()) errors.push(`inputs.${d.key}: required`);
  }
  if (errors.length) return { ok: false, status: 400, body: { errors } };

  const inputs: Record<string, unknown> = {};
  let untrustedPullSource = false;
  for (const d of defs) {
    const value = raw[d.key] ?? "";
    if (d.type === "text") {
      inputs[d.key] = value;
      continue;
    }
    if (!value.trim()) {
      inputs[d.key] = null;
      continue;
    }
    try {
      const resolved = await fetchGitHubInput(deps, d.type, value);
      inputs[d.key] = resolved.value;
      untrustedPullSource ||= resolved.untrustedSource;
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      if (err.message === INVALID_URL[d.type]) return { ok: false, status: 400, body: { error: err.message } };
      const clientSide = err.status >= 400 && err.status < 500;
      return { ok: false, status: clientSide ? 400 : 502, body: { error: `inputs.${d.key}: ${err.message}` } };
    }
  }
  return { ok: true, inputs, untrustedPullSource };
}

const INVALID_URL = { github_issue: "Invalid GitHub issue URL", github_pull_request: "Invalid GitHub pull request URL" } as const;

async function fetchGitHubInput(
  deps: Pick<AppDeps, "credentials" | "github">,
  type: "github_issue" | "github_pull_request",
  url: string,
): Promise<{ value: GitHubIssueInput | PullRequestInput; untrustedSource: boolean }> {
  const ref = type === "github_issue" ? parseIssueUrl(url) : parsePullUrl(url);
  if (!ref) throw new GitHubError(INVALID_URL[type], 0);
  // A repo the App cannot access is a 4xx GitHubError (an input problem); other credential failures are server errors.
  const token = deps.credentials.configured ? await deps.credentials.tokenFor(ref.repo, "read") : null;
  if (type === "github_issue") return { value: await deps.github.getIssue(ref, token), untrustedSource: false };
  const pr = await deps.github.getPull(ref, token);
  return { value: pullRequestInput(pr), untrustedSource: pr.untrustedSource };
}

/**
 * Creates a run of `flow` with resolved inputs, applying the flow's `forkPolicy` for PR runs. Task runs
 * pass `opts.task` (role, handler and overrides) straight into `insertRun`. A dedupe loss (`insertRun`
 * returning null) is impossible for manual starts, so it fails loudly.
 */
export async function startRun(
  deps: AppDeps,
  flow: { id: string; version: number; definition: FlowDefinition },
  opts: StartRunOptions,
): Promise<Op<{ runId: string }>> {
  const resolved = await resolveInputs(deps, flow.definition.inputs, opts.inputs);
  if (!resolved.ok) return resolved;
  const status = initialPullRunStatus(flow.definition.trigger, resolved.untrustedPullSource);
  if (status === null) {
    return { ok: false, status: 403, body: { error: 'Flow forkPolicy is "skip": fork and first-time-contributor pull requests never run' } };
  }
  opts.task?.authorize?.();
  const id = insertRun(
    deps,
    flow,
    resolved.inputs,
    {
      triggerKind: "manual",
      createdBy: opts.createdBy,
      status,
      ...(opts.task !== undefined ? { taskId: opts.task.taskId, role: opts.task.role } : {}),
      ...(opts.task?.interventionHandler !== undefined ? { interventionHandler: opts.task.interventionHandler } : {}),
      ...(opts.task?.overrides !== undefined ? { overrides: opts.task.overrides } : {}),
    },
    {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.autoName ? { autoName: true } : {}),
    },
  );
  if (id === null) throw new Error("unreachable: manual runs have no dedupe key");
  const github = deps.runs.get(id)!.github;
  if (github) {
    console.log(`[runs] flow ${flow.definition.name} started on ${github.repo}#${github.number} → run ${id} (${status})`);
    deps.checks.createCheckRun(id, status === "awaiting_approval");
  }
  deps.scheduler.kick();
  return { ok: true, runId: id };
}

export function cancelRun(deps: Pick<AppDeps, "runs">, runId: string): Op {
  switch (deps.runs.cancel(runId)) {
    case "not_found":
      return { ok: false, status: 404, body: { error: "Run not found" } };
    case "already_terminal":
      return { ok: false, status: 409, body: { error: "Run already finished" } };
    default:
      return { ok: true };
  }
}

export function retryRun(deps: AppDeps, runId: string, fromStepId?: string): Op {
  const run = deps.runs.get(runId);
  if (!run) return { ok: false, status: 404, body: { error: "Run not found" } };
  // A manager restarts only through its task (`TaskService.ensureManager`): retrying an old one could bring it
  // back next to the live replacement, and two managers would act on the same inbox.
  if (run.role === "manager") {
    return { ok: false, status: 409, body: { error: "Manager runs cannot be retried; send the task a message to restart its manager" } };
  }
  let fromStepIdx = 0;
  if (fromStepId !== undefined) {
    fromStepIdx = run.definition.steps.findIndex((s) => s.id === fromStepId);
    if (fromStepIdx < 0) return { ok: false, status: 400, body: { error: `Unknown step "${fromStepId}"` } };
  } else {
    // Default: the first step (definition order) that is neither succeeded nor skipped (`skipped` steps
    // were bypassed by a loop stop or sit in a condition branch not taken, and count as done); the last step when all are done.
    const done = new Set(
      deps.db
        .select({ stepId: runSteps.stepId, status: runSteps.status })
        .from(runSteps)
        .where(eq(runSteps.runId, runId))
        .all()
        .filter((s) => s.status === "succeeded" || s.status === "skipped")
        .map((s) => s.stepId),
    );
    fromStepIdx = run.definition.steps.findIndex((s) => !done.has(s.id));
    if (fromStepIdx < 0) fromStepIdx = run.definition.steps.length - 1;
  }
  const outcome = deps.runs.retry(runId, fromStepIdx);
  if (!outcome.ok) {
    switch (outcome.error) {
      case "not_found":
        return { ok: false, status: 404, body: { error: "Run not found" } };
      case "not_retryable":
        return { ok: false, status: 409, body: { error: `Run is ${run.status}; only failed or cancelled runs can be retried` } };
      case "unfinished_steps":
        return { ok: false, status: 409, body: { error: "Cannot skip unfinished steps" } };
      case "mid_skipped_branch":
        return { ok: false, status: 409, body: { error: "This step is in a branch the run did not take; run from the first step of that branch" } };
      case "bad_step":
        return { ok: false, status: 400, body: { error: "Invalid step index" } };
    }
  }
  console.log(`[runs] run ${runId} retry from step ${run.definition.steps[fromStepIdx]?.id ?? fromStepIdx}`);
  // Any PR run (webhook or manual) needs a fresh check run for the retried execution.
  if (run.github) deps.checks.createCheckRun(runId, false);
  deps.scheduler.kick();
  return { ok: true };
}

/** Resolves the live runner holding a non-terminal run, or an op error. */
export function holder(deps: Pick<AppDeps, "runs" | "hub">, runId: string): { ok: true; runnerId: string } | OpError {
  const run = deps.runs.get(runId);
  if (!run) return { ok: false, status: 404, body: { error: "Run not found" } };
  if (isTerminal(run.status)) return { ok: false, status: 409, body: { error: "Run already finished" } };
  if (!run.runnerId || !deps.hub.isConnected(run.runnerId)) return { ok: false, status: 409, body: { error: "Runner offline" } };
  return { ok: true, runnerId: run.runnerId };
}

export function respondPermission(deps: AppDeps, runId: string, requestId: string, optionId: string | null): Op {
  const h = holder(deps, runId);
  if (!h.ok) return h;
  deps.hub.sendToRunner(h.runnerId, { t: "permission.respond", runId, requestId, optionId });
  return { ok: true };
}

export function respondElicitation(
  deps: AppDeps,
  runId: string,
  requestId: string,
  action: ElicitationAction,
  content?: Record<string, unknown>,
): Op {
  const h = holder(deps, runId);
  if (!h.ok) return h;
  deps.hub.sendToRunner(h.runnerId, {
    t: "elicitation.respond",
    runId,
    requestId,
    action,
    ...(content === undefined ? {} : { content }),
  });
  return { ok: true };
}

/** Answers an intervention gate: chat with a session, continue (with the pick on gates with choices), repeat (ask loop), or cancel. */
export function respondIntervention(
  deps: AppDeps,
  runId: string,
  requestId: string,
  answer: { stepId: string; action: InterventionAction; session?: string; text?: string; choice?: string },
): Op {
  const h = holder(deps, runId);
  if (!h.ok) return h;
  const run = deps.runs.get(runId)!;
  const step = run.definition.steps.find((s) => s.id === answer.stepId);
  const isAskLoop = step?.kind === "loop" && step.stop.when === "ask";
  if (step?.kind !== "intervention" && !isAskLoop)
    return { ok: false, status: 400, body: { error: `Step "${answer.stepId}" is not an intervention step` } };
  if (answer.action === "repeat" && !isAskLoop)
    return { ok: false, status: 400, body: { error: `Step "${answer.stepId}" cannot be repeated` } };
  const { action, session, text, choice } = answer;
  const choices = step?.kind === "intervention" ? step.choices : undefined;
  if (choice !== undefined && !choices) return { ok: false, status: 400, body: { error: `Step "${answer.stepId}" has no choices` } };
  if (choice !== undefined && action !== "continue")
    return { ok: false, status: 400, body: { error: `A choice goes with "continue", not "${action}"` } };
  if (choices && action === "continue" && !choices.some((ch) => ch.id === choice)) {
    return {
      ok: false,
      status: 400,
      body: { error: `Step "${answer.stepId}" requires a choice (${choices.map((ch) => ch.id).join(", ")})` },
    };
  }
  deps.hub.sendToRunner(h.runnerId, {
    t: "intervention.respond",
    runId,
    requestId,
    action,
    ...(session === undefined ? {} : { session }),
    ...(text === undefined ? {} : { text }),
    ...(choice === undefined ? {} : { choice }),
  });
  return { ok: true };
}
