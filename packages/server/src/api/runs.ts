import {
  ElicitationAction,
  InterventionAction,
  type GitHubIssueInput,
  harnessModelErrors,
  type InputDef,
  isEmptyInputValue,
  isGitHubInput,
  materializeFlow,
  parseInputValue,
  type PullRequestInput,
  type RunDetail,
  RUN_NAME_MAX,
  RUNS_PAGE_SIZE,
  RunsQuery,
  SetRunModelsBody,
} from "@orch/protocol";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import { initialPullRunStatus, insertRun, pullRequestInput } from "../createRun";
import { GitHubError, parseIssueUrl, parsePullUrl } from "../github/api";
import { RpcError } from "../hub";
import { findingRow, runRow, stepRow } from "../rows";
import { isTerminal } from "../runs";
import { eventsAfter } from "../ws/browser";
import { issueMessages, readJson } from "./util";

const { flows, runs, runSteps, findings } = schema;

const CreateRunBody = z
  .object({
    inputs: z.record(z.string(), z.string()).optional(),
    name: z.string().trim().min(1).max(RUN_NAME_MAX).optional(),
    autoName: z.boolean().optional(),
  })
  .refine((b) => !(b.name !== undefined && b.autoName), {
    message: "Pass either name or autoName, not both",
    path: ["name"],
  });
const PermissionBody = z.object({ optionId: z.string().min(1).nullable() });
const RetryBody = z.object({ fromStepId: z.string().min(1).optional() });
const ElicitationBody = z.object({ action: ElicitationAction, content: z.record(z.string(), z.unknown()).optional() });
const InterventionBody = z
  .object({
    stepId: z.string().min(1),
    action: InterventionAction,
    session: z.string().min(1).optional(),
    text: z.string().optional(),
    /** `continue` on a gate with choices: the picked choice id. */
    choice: z.string().min(1).optional(),
  })
  .refine((b) => b.action !== "message" || (b.session !== undefined && (b.text ?? "").trim() !== ""), {
    message: "message: pick a session and write a message",
    path: ["text"],
  });

/** Time the runner gets to take a model switch (it may queue behind a harness restart for an earlier one). */
const SET_MODELS_TIMEOUT_MS = 30_000;

export type InputResolution =
  | { ok: true; inputs: Record<string, unknown>; untrustedPullSource: boolean }
  | { ok: false; status: 400 | 502; body: { error: string } | { errors: string[] } };

/**
 * Checks raw string inputs against the flow's `InputDef`s: value inputs go through `parseInputValue` (an empty
 * one takes its `default`, else `""`), `github_issue` and `github_pull_request` URLs are resolved (empty: `null`).
 * Required inputs must have a value after defaults. `untrustedPullSource` reports a fork or first-time-contributor
 * pull request input.
 */
export async function resolveInputs(
  deps: Pick<AppDeps, "credentials" | "github">,
  defs: InputDef[],
  raw: Record<string, string>,
): Promise<InputResolution> {
  const errors: string[] = [];
  const declared = new Set(defs.map((d) => d.key));
  for (const key of Object.keys(raw)) if (!declared.has(key)) errors.push(`inputs.${key}: not declared by the flow`);
  const inputs: Record<string, unknown> = {};
  for (const d of defs) {
    const value = raw[d.key] ?? "";
    if (isGitHubInput(d)) {
      if (d.required && !value.trim()) errors.push(`inputs.${d.key}: required`);
      continue;
    }
    const parsed = parseInputValue(d, value);
    if (!parsed.ok) errors.push(`inputs.${d.key}: ${parsed.error}`);
    else if (d.required && isEmptyInputValue(parsed.value)) errors.push(`inputs.${d.key}: required`);
    else inputs[d.key] = parsed.value;
  }
  if (errors.length) return { ok: false, status: 400, body: { errors } };

  let untrustedPullSource = false;
  for (const d of defs) {
    if (!isGitHubInput(d)) continue;
    const value = raw[d.key] ?? "";
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
  return { ok: true, inputs: Object.fromEntries(defs.map((d) => [d.key, inputs[d.key]])), untrustedPullSource };
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

export function runRoutes(deps: AppDeps): { flowRuns: Hono; runs: Hono } {
  const { db, hub } = deps;

  const flowRuns = new Hono();
  flowRuns.post("/:id/runs", async (c) => {
    const flow = db.select().from(flows).where(eq(flows.id, c.req.param("id"))).get();
    if (!flow) return c.json({ error: "Flow not found" }, 404);
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = CreateRunBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const resolved = await resolveInputs(deps, flow.definition.inputs, parsed.data.inputs ?? {});
    if (!resolved.ok) return c.json(resolved.body, resolved.status);
    // The run keeps its own copy with the bound fields filled in: scheduler, runner and retry read final values.
    const materialized = materializeFlow(flow.definition, resolved.inputs);
    if (!materialized.ok) return c.json({ errors: materialized.errors }, 400);
    const status = initialPullRunStatus(flow.definition.trigger, resolved.untrustedPullSource);
    if (status === null) {
      return c.json({ error: 'Flow forkPolicy is "skip": fork and first-time-contributor pull requests never run' }, 403);
    }

    const id = insertRun(
      deps,
      { ...flow, definition: materialized.flow },
      resolved.inputs,
      { triggerKind: "manual", createdBy: c.get("user")?.id ?? null, status },
      { ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}), ...(parsed.data.autoName ? { autoName: true } : {}) },
    );
    if (id === null) throw new Error("unreachable: manual runs have no dedupe key");
    const github = deps.runs.get(id)!.github;
    if (github) {
      console.log(`[runs] flow ${flow.name} started on ${github.repo}#${github.number} → run ${id} (${status})`);
      deps.checks.createCheckRun(id, status === "awaiting_approval");
    }
    deps.scheduler.kick();
    return c.json(runRow(deps.runs.get(id)!), 201);
  });

  const app = new Hono();

  /** Newest first, at most `RUNS_PAGE_SIZE` rows; `before` pages on the same `(createdAt, id)` order. */
  app.get("/", (c) => {
    const parsed = RunsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const { flowId, status, before, q } = parsed.data;
    // instr() rather than LIKE: the search text is matched literally, with no `%`/`_` escaping to get wrong.
    // Both sides go through SQLite's lower() (ASCII-only folding): lowercasing the needle in JS would fold
    // non-ASCII letters the column side keeps, so e.g. "Échec" could never match itself.
    const needle = q || undefined;
    const rows = db
      .select()
      .from(runs)
      .where(
        and(
          flowId ? eq(runs.flowId, flowId) : undefined,
          status ? inArray(runs.status, status) : undefined,
          before
            ? or(lt(runs.createdAt, before.createdAt), and(eq(runs.createdAt, before.createdAt), lt(runs.id, before.id)))
            : undefined,
          needle
            ? or(
                sql`instr(lower(${runs.id}), lower(${needle})) > 0`,
                sql`instr(lower(coalesce(${runs.name}, '')), lower(${needle})) > 0`,
              )
            : undefined,
        ),
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(RUNS_PAGE_SIZE)
      .all();
    return c.json(rows.map(runRow));
  });

  app.get("/:id", (c) => {
    const id = c.req.param("id");
    const run = deps.runs.get(id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    const detail: RunDetail = {
      run: runRow(run),
      steps: db.select().from(runSteps).where(eq(runSteps.runId, id)).orderBy(asc(runSteps.idx)).all().map(stepRow),
      findings: db.select().from(findings).where(eq(findings.runId, id)).orderBy(asc(findings.id)).all().map(findingRow),
    };
    return c.json(detail);
  });

  app.get("/:id/events", (c) => {
    const id = c.req.param("id");
    if (!deps.runs.get(id)) return c.json({ error: "Run not found" }, 404);
    const afterSeq = Math.max(0, Number(c.req.query("afterSeq") ?? 0) || 0);
    return c.json(eventsAfter(deps, id, afterSeq));
  });

  app.post("/:id/cancel", (c) => {
    switch (deps.runs.cancel(c.req.param("id"))) {
      case "not_found":
        return c.json({ error: "Run not found" }, 404);
      case "already_terminal":
        return c.json({ error: "Run already finished" }, 409);
      default:
        return c.json({ ok: true });
    }
  });

  /** Retries a failed or cancelled run: from the first unfinished step (default) or from `fromStepId` (skipping nothing unfinished). */
  app.post("/:id/retry", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = RetryBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const run = deps.runs.get(id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    let fromStepIdx = 0;
    if (parsed.data.fromStepId !== undefined) {
      fromStepIdx = run.definition.steps.findIndex((s) => s.id === parsed.data.fromStepId);
      if (fromStepIdx < 0) return c.json({ error: `Unknown step "${parsed.data.fromStepId}"` }, 400);
    } else {
      // Default: the first step (definition order) that is neither succeeded nor skipped (`skipped` steps
      // were bypassed by a loop stop or sit in a condition branch not taken, and count as done); the last step when all are done.
      const done = new Set(
        db
          .select({ stepId: runSteps.stepId, status: runSteps.status })
          .from(runSteps)
          .where(eq(runSteps.runId, id))
          .all()
          .filter((s) => s.status === "succeeded" || s.status === "skipped")
          .map((s) => s.stepId),
      );
      fromStepIdx = run.definition.steps.findIndex((s) => !done.has(s.id));
      if (fromStepIdx < 0) fromStepIdx = run.definition.steps.length - 1;
    }
    const outcome = deps.runs.retry(id, fromStepIdx);
    if (!outcome.ok) {
      switch (outcome.error) {
        case "not_found":
          return c.json({ error: "Run not found" }, 404);
        case "not_retryable":
          return c.json({ error: `Run is ${run.status}; only failed or cancelled runs can be retried` }, 409);
        case "unfinished_steps":
          return c.json({ error: "Cannot skip unfinished steps" }, 409);
        case "mid_skipped_branch":
          return c.json({ error: "This step is in a branch the run did not take; run from the first step of that branch" }, 409);
        case "bad_step":
          return c.json({ error: "Invalid step index" }, 400);
      }
    }
    console.log(`[runs] run ${id} retry from step ${run.definition.steps[fromStepIdx]?.id ?? fromStepIdx}`);
    // Any PR run (webhook or manual) needs a fresh check run for the retried execution.
    if (run.github) deps.checks.createCheckRun(id, false);
    deps.scheduler.kick();
    return c.json({ ok: true });
  });

  app.post("/:id/approve", (c) => {
    const id = c.req.param("id");
    const approved = db
      .update(runs)
      .set({ status: "queued" })
      .where(and(eq(runs.id, id), eq(runs.status, "awaiting_approval")))
      .returning({ id: runs.id })
      .all();
    if (approved.length === 0) {
      const run = deps.runs.get(id);
      if (!run) return c.json({ error: "Run not found" }, 404);
      return c.json({ error: `Run is ${run.status}, not awaiting approval` }, 409);
    }
    console.log(`[runs] run ${id} approved by ${c.get("user")?.login ?? "local user"}`);
    deps.scheduler.kick();
    return c.json({ ok: true });
  });

  /** Resolves the live runner holding a non-terminal run, or an error response. */
  function holder(runId: string): { runnerId: string } | { error: string; status: 404 | 409 } {
    const run = deps.runs.get(runId);
    if (!run) return { error: "Run not found", status: 404 };
    if (isTerminal(run.status)) return { error: "Run already finished", status: 409 };
    if (!run.runnerId || !hub.isConnected(run.runnerId)) return { error: "Runner offline", status: 409 };
    return { runnerId: run.runnerId };
  }

  /**
   * Replaces the run's harness models (every role). A run its runner holds switches first, over the `job.setModels`
   * RPC: the stored definition is written here once the runner took it, and in any case by the projection of the
   * runner's `run.models` event (so a call that timed out or lost the runner after sending still ends up stored).
   * Queued runs pick the stored models up with `job.assign`, failed and cancelled ones on retry.
   */
  app.put("/:id/models", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = SetRunModelsBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const models = parsed.data;
    const errors = harnessModelErrors(models, "");
    if (errors.length) return c.json({ errors }, 400);
    const run = deps.runs.get(id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    if (run.status === "succeeded") return c.json({ error: "Run already finished" }, 409);
    if (run.status === "assigned" || run.status === "running" || run.status === "awaiting_input") {
      const h = holder(id);
      if ("error" in h) return c.json({ error: h.error }, h.status);
      try {
        await hub.rpc(h.runnerId, "job.setModels", { runId: id, models }, SET_MODELS_TIMEOUT_MS);
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
        if (err.kind === "offline") return c.json({ error: "Runner offline" }, 409);
        return c.json({ error: `Runner did not switch models: ${err.message}` }, 502);
      }
    }
    // Fast path for live runs (the `run.models` projection writes the same set); the only write for the others.
    const definition = deps.runs.get(id)!.definition;
    db.update(runs)
      .set({ definition: { ...definition, harness: { id: definition.harness.id, ...models } } })
      .where(eq(runs.id, id))
      .run();
    console.log(`[runs] run ${id} models switched to ${models.model}`);
    return c.json(runRow(deps.runs.get(id)!));
  });

  app.post("/:id/permissions/:requestId", async (c) => {
    const { id, requestId } = c.req.param();
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = PermissionBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const h = holder(id);
    if ("error" in h) return c.json({ error: h.error }, h.status);
    hub.sendToRunner(h.runnerId, { t: "permission.respond", runId: id, requestId, optionId: parsed.data.optionId });
    return c.json({ ok: true });
  });

  app.post("/:id/elicitations/:requestId", async (c) => {
    const { id, requestId } = c.req.param();
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = ElicitationBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const h = holder(id);
    if ("error" in h) return c.json({ error: h.error }, h.status);
    const { action, content } = parsed.data;
    hub.sendToRunner(h.runnerId, {
      t: "elicitation.respond",
      runId: id,
      requestId,
      action,
      ...(content === undefined ? {} : { content }),
    });
    return c.json({ ok: true });
  });

  /** Answers an intervention gate: chat with a session, continue (with the pick on gates with choices), repeat (ask loop), or cancel. */
  app.post("/:id/interventions/:requestId", async (c) => {
    const { id, requestId } = c.req.param();
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = InterventionBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const h = holder(id);
    if ("error" in h) return c.json({ error: h.error }, h.status);
    const run = deps.runs.get(id)!;
    const step = run.definition.steps.find((s) => s.id === parsed.data.stepId);
    const isAskLoop = step?.kind === "loop" && step.stop.when === "ask";
    if (step?.kind !== "intervention" && !isAskLoop)
      return c.json({ error: `Step "${parsed.data.stepId}" is not an intervention step` }, 400);
    if (parsed.data.action === "repeat" && !isAskLoop)
      return c.json({ error: `Step "${parsed.data.stepId}" cannot be repeated` }, 400);
    const { action, session, text, choice } = parsed.data;
    const choices = step?.kind === "intervention" ? step.choices : undefined;
    if (choice !== undefined && !choices) return c.json({ error: `Step "${parsed.data.stepId}" has no choices` }, 400);
    if (choice !== undefined && action !== "continue") return c.json({ error: `A choice goes with "continue", not "${action}"` }, 400);
    if (choices && action === "continue" && !choices.some((ch) => ch.id === choice)) {
      return c.json({ error: `Step "${parsed.data.stepId}" requires a choice (${choices.map((ch) => ch.id).join(", ")})` }, 400);
    }
    hub.sendToRunner(h.runnerId, {
      t: "intervention.respond",
      runId: id,
      requestId,
      action,
      ...(session === undefined ? {} : { session }),
      ...(text === undefined ? {} : { text }),
      ...(choice === undefined ? {} : { choice }),
    });
    return c.json({ ok: true });
  });

  return { flowRuns, runs: app };
}
