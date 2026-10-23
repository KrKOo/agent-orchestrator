import { ElicitationAction, type GitHubIssueInput, type InputDef, type RunDetail } from "@orch/protocol";
import { and, asc, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import { GitHubError, ISSUE_URL_RE } from "../github/api";
import { findingRow, runRow, stepRow } from "../rows";
import { isTerminal } from "../runs";
import { eventsAfter } from "../ws/browser";
import { issueMessages, readJson } from "./util";

const { flows, runs, runSteps, findings } = schema;

const CreateRunBody = z.object({ inputs: z.record(z.string(), z.string()).default({}) });
const PermissionBody = z.object({ optionId: z.string().min(1).nullable() });
const ElicitationBody = z.object({ action: ElicitationAction, content: z.record(z.string(), z.unknown()).optional() });

export type InputResolution =
  | { ok: true; inputs: Record<string, unknown> }
  | { ok: false; status: 400 | 502; body: { error: string } | { errors: string[] } };

/**
 * Checks raw string inputs against the flow's `InputDef`s and resolves `github_issue` inputs.
 * Optional inputs left empty become `""` (text) or `null` (github_issue).
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
      inputs[d.key] = await fetchIssue(deps, value);
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      if (err.message === "Invalid GitHub issue URL") return { ok: false, status: 400, body: { error: err.message } };
      const clientSide = err.status >= 400 && err.status < 500;
      return { ok: false, status: clientSide ? 400 : 502, body: { error: `inputs.${d.key}: ${err.message}` } };
    }
  }
  return { ok: true, inputs };
}

async function fetchIssue(deps: Pick<AppDeps, "credentials" | "github">, url: string): Promise<GitHubIssueInput> {
  const m = ISSUE_URL_RE.exec(url.trim());
  if (!m) throw new GitHubError("Invalid GitHub issue URL", 0);
  const token = deps.credentials.configured ? await deps.credentials.tokenFor(`${m[1]}/${m[2]}`, "read") : null;
  return deps.github.getIssue(url, token);
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
    const resolved = await resolveInputs(deps, flow.definition.inputs, parsed.data.inputs);
    if (!resolved.ok) return c.json(resolved.body, resolved.status);

    if (flow.definition.trigger.kind !== "manual") {
      return c.json({ error: "This flow runs on GitHub pull requests and cannot be started manually" }, 400);
    }
    const id = ulid();
    const now = Date.now();
    db.transaction((tx) => {
      tx.insert(runs)
        .values({
          id,
          flowId: flow.id,
          flowVersion: flow.version,
          definition: flow.definition,
          inputs: resolved.inputs,
          status: "queued",
          trust: "owner",
          triggerKind: "manual",
          createdBy: c.get("user")?.id ?? null,
          createdAt: now,
        })
        .run();
      tx.insert(runSteps)
        .values(flow.definition.steps.map((s, idx) => ({ runId: id, stepId: s.id, idx, status: "pending" as const })))
        .run();
    });
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

  return { flowRuns, runs: app };
}
