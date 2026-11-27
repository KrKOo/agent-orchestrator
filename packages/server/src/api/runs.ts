// Thin REST handlers over `run-ops.ts`: zod-parse the body, call the op, map its result to a response.
// The manager tools (`manager.tool` RPC) call the same ops, so both paths validate identically.
import {
  ElicitationAction,
  INTERVENTION_MESSAGE_ISSUE,
  InterventionAnswer,
  interventionMessageValid,
  harnessModelErrors,
  type RunDetail,
  RUN_NAME_MAX,
  RUNS_PAGE_SIZE,
  RunsQuery,
  SetRunHandlerBody,
  SetRunModelsBody,
} from "@orch/protocol";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import { RpcError } from "../hub";
import { findingRow, runRow, stepRow } from "../rows";
import { cancelRun, holder, type Op, respondElicitation, respondIntervention, respondPermission, retryRun, startRun } from "../run-ops";
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
const InterventionBody = InterventionAnswer.refine(interventionMessageValid, INTERVENTION_MESSAGE_ISSUE);

/** Time the runner gets to take a model switch (it may queue behind a harness restart for an earlier one). */
const SET_MODELS_TIMEOUT_MS = 30_000;

/** Maps an op result to a Hono response; successes carry only `{ok: true}`. */
function opResponse(c: { json: (body: unknown, status?: number) => Response }, op: Op): Response {
  return op.ok ? c.json({ ok: true }) : c.json(op.body, op.status);
}

export function runRoutes(deps: AppDeps): { flowRuns: Hono; runs: Hono } {
  const flowRuns = new Hono();
  flowRuns.post("/:id/runs", async (c) => {
    const flow = deps.db.select().from(flows).where(eq(flows.id, c.req.param("id"))).get();
    if (!flow) return c.json({ error: "Flow not found" }, 404);
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = CreateRunBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const started = await startRun(deps, flow, {
      inputs: parsed.data.inputs ?? {},
      createdBy: c.get("user")?.id ?? null,
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.autoName !== undefined ? { autoName: parsed.data.autoName } : {}),
    });
    if (!started.ok) return c.json(started.body, started.status);
    return c.json(runRow(deps.runs.get(started.runId)!), 201);
  });

  const app = new Hono();

  /** Newest first, at most `RUNS_PAGE_SIZE` rows; `before` pages on the same `(createdAt, id)` order. */
  app.get("/", (c) => {
    const parsed = RunsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const { flowId, status, before, q, taskId, handler } = parsed.data;
    // instr() rather than LIKE: the search text is matched literally, with no `%`/`_` escaping to get wrong.
    // Both sides go through SQLite's lower() (ASCII-only folding): lowercasing the needle in JS would fold
    // non-ASCII letters the column side keeps, so e.g. "Échec" could never match itself.
    const needle = q || undefined;
    const rows = deps.db
      .select()
      .from(runs)
      .where(
        and(
          flowId ? eq(runs.flowId, flowId) : undefined,
          status ? inArray(runs.status, status) : undefined,
          before
            ? or(lt(runs.createdAt, before.createdAt), and(eq(runs.createdAt, before.createdAt), lt(runs.id, before.id)))
            : undefined,
          taskId ? eq(runs.taskId, taskId) : undefined,
          // `handler=user`: runs whose requests the user answers — runs outside a task, and task child
          // runs handed to the user ("Take over"); the manager's own runs are never handed back. Approval is
          // always the user's: the manager handles interventions and permission requests, never `awaiting_approval`.
          handler === "user"
            ? or(
                eq(runs.status, "awaiting_approval"),
                and(
                  or(isNull(runs.interventionHandler), eq(runs.interventionHandler, "user")),
                  sql`coalesce(${runs.role}, '') <> 'manager'`,
                ),
              )
            : undefined,
          handler === "manager" ? eq(runs.interventionHandler, "manager") : undefined,
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
      steps: deps.db.select().from(runSteps).where(eq(runSteps.runId, id)).orderBy(asc(runSteps.idx)).all().map(stepRow),
      findings: deps.db.select().from(findings).where(eq(findings.runId, id)).orderBy(asc(findings.id)).all().map(findingRow),
    };
    return c.json(detail);
  });

  app.get("/:id/events", (c) => {
    const id = c.req.param("id");
    if (!deps.runs.get(id)) return c.json({ error: "Run not found" }, 404);
    const afterSeq = Math.max(0, Number(c.req.query("afterSeq") ?? 0) || 0);
    return c.json(eventsAfter(deps, id, afterSeq));
  });

  app.post("/:id/cancel", (c) => opResponse(c, cancelRun(deps, c.req.param("id"))));

  app.post("/:id/retry", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = RetryBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    return opResponse(c, retryRun(deps, c.req.param("id"), parsed.data.fromStepId));
  });

  app.post("/:id/approve", (c) => {
    const id = c.req.param("id");
    const approved = deps.db
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

  /**
   * `PUT /:id/handler`: hand a task child run's requests to the user or back to the manager. The manager reads the
   * field at event time; handing back also re-delivers the requests still open (`ManagerService.onHandlerChanged`).
   */
  app.put("/:id/handler", async (c) => {
    const id = c.req.param("id");
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = SetRunHandlerBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const run = deps.runs.get(id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    if (run.taskId === null || run.role !== "worker") {
      return c.json({ error: "Only a task's worker runs have an intervention handler" }, 400);
    }
    const previous = run.interventionHandler ?? deps.tasks.get(run.taskId)?.settings.interventions;
    const updated = deps.db
      .update(runs)
      .set({ interventionHandler: parsed.data.handler })
      .where(eq(runs.id, id))
      .returning()
      .get();
    if (previous !== undefined) deps.manager.onHandlerChanged(id, previous);
    return c.json(runRow(updated ?? deps.runs.get(id)!));
  });

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
      const h = holder(deps, id);
      if (!h.ok) return c.json(h.body, h.status);
      try {
        await deps.hub.rpc(h.runnerId, "job.setModels", { runId: id, models }, SET_MODELS_TIMEOUT_MS);
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
        if (err.kind === "offline") return c.json({ error: "Runner offline" }, 409);
        return c.json({ error: `Runner did not switch models: ${err.message}` }, 502);
      }
    }
    // Fast path for live runs (the `run.models` projection writes the same set); the only write for the others.
    const definition = deps.runs.get(id)!.definition;
    deps.db
      .update(runs)
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
    return opResponse(c, respondPermission(deps, id, requestId, parsed.data.optionId));
  });

  app.post("/:id/elicitations/:requestId", async (c) => {
    const { id, requestId } = c.req.param();
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = ElicitationBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    return opResponse(c, respondElicitation(deps, id, requestId, parsed.data.action, parsed.data.content));
  });

  app.post("/:id/interventions/:requestId", async (c) => {
    const { id, requestId } = c.req.param();
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = InterventionBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    return opResponse(c, respondIntervention(deps, id, requestId, parsed.data));
  });

  return { flowRuns, runs: app };
}
