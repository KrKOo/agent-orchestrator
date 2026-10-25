import {
  ElicitationAction,
  InterventionAction,
  type GitHubIssueInput,
  type InputDef,
  type PullRequestInput,
  type RunDetail,
} from "@orch/protocol";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import { initialPullRunStatus, insertRun, pullRequestInput } from "../createRun";
import { GitHubError, parseIssueUrl, parsePullUrl } from "../github/api";
import { findingRow, runRow, stepRow } from "../rows";
import { isTerminal } from "../runs";
import { eventsAfter } from "../ws/browser";
import { issueMessages, readJson } from "./util";

const { flows, runs, runSteps, findings } = schema;

const CreateRunBody = z.object({ inputs: z.record(z.string(), z.string()).optional() });
const PermissionBody = z.object({ optionId: z.string().min(1).nullable() });
const RetryBody = z.object({ fromStepId: z.string().min(1).optional() });
const ElicitationBody = z.object({ action: ElicitationAction, content: z.record(z.string(), z.unknown()).optional() });
const InterventionBody = z
  .object({
    stepId: z.string().min(1),
    action: InterventionAction,
    session: z.string().min(1).optional(),
    text: z.string().optional(),
  })
  .refine((b) => b.action !== "message" || (b.session !== undefined && (b.text ?? "").trim() !== ""), {
    message: "message: pick a session and write a message",
    path: ["text"],
  });

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
    const status = initialPullRunStatus(flow.definition.trigger, resolved.untrustedPullSource);
    if (status === null) {
      return c.json({ error: 'Flow forkPolicy is "skip": fork and first-time-contributor pull requests never run' }, 403);
    }

    const id = insertRun(deps, flow, resolved.inputs, { triggerKind: "manual", createdBy: c.get("user")?.id ?? null, status });
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

  app.get("/", (c) => {
    const flowId = c.req.query("flowId");
    const rows = db
      .select()
      .from(runs)
      .where(flowId ? eq(runs.flowId, flowId) : undefined)
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(200)
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
      // Default: the first step (definition order) that did not succeed; the last step when all did.
      const succeeded = new Set(
        db
          .select({ stepId: runSteps.stepId, status: runSteps.status })
          .from(runSteps)
          .where(eq(runSteps.runId, id))
          .all()
          .filter((s) => s.status === "succeeded")
          .map((s) => s.stepId),
      );
      fromStepIdx = run.definition.steps.findIndex((s) => !succeeded.has(s.id));
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

  /** Answers an intervention gate: send a chat message to a session, continue the run, or cancel. */
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
    if (step?.kind !== "intervention") return c.json({ error: `Step "${parsed.data.stepId}" is not an intervention step` }, 400);
    const { action, session, text } = parsed.data;
    hub.sendToRunner(h.runnerId, {
      t: "intervention.respond",
      runId: id,
      requestId,
      action,
      ...(session === undefined ? {} : { session }),
      ...(text === undefined ? {} : { text }),
    });
    return c.json({ ok: true });
  });

  return { flowRuns, runs: app };
}
