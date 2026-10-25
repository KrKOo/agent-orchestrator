import { pullRequestInputOf, type RunStatus } from "@orch/protocol";
import type { Webhooks } from "@octokit/webhooks";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { initialPullRunStatus, insertRun, pullRequestInput } from "../createRun";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import { ACTIVE_STATUSES } from "../scheduler";
import { isUntrustedPullSource } from "./api";

const { flows, runs, webhookDeliveries } = schema;

const PullRequestEvent = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int() }).optional(),
  repository: z.object({ full_name: z.string() }),
  pull_request: z.object({
    html_url: z.string(),
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullable(),
    author_association: z.string(),
    head: z.object({ sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
    base: z.object({ sha: z.string(), repo: z.object({ full_name: z.string() }) }),
  }),
});
type PullRequestEvent = z.infer<typeof PullRequestEvent>;

const PENDING_STATUSES: RunStatus[] = ["queued", "awaiting_approval"];

export interface WebhookRequest {
  event: string | undefined;
  deliveryId: string | undefined;
  signature: string | undefined;
  /** Raw request body, exactly as signed. */
  body: string;
}

export interface WebhookResult {
  status: 200 | 202 | 400 | 401;
  body: { ok: true; duplicate?: true; runIds?: string[] } | { error: string };
}

/** Verifies `X-Hub-Signature-256` over the raw body. */
export async function verifySignature(webhooks: Webhooks, body: string, signature: string | undefined): Promise<boolean> {
  if (!signature) return false;
  try {
    return await webhooks.verify(body, signature);
  } catch {
    return false;
  }
}

/**
 * `POST /github/webhook`: signature check, delivery dedupe, then for `pull_request` events one run per
 * matching flow (with supersede and fork policy); the PR fills the flow's `github_pull_request` input.
 * Runs never execute inline; GitHub calls are queued.
 */
export async function handleWebhook(deps: AppDeps, webhooks: Webhooks, req: WebhookRequest): Promise<WebhookResult> {
  if (!(await verifySignature(webhooks, req.body, req.signature))) return { status: 401, body: { error: "invalid signature" } };
  if (!req.deliveryId) return { status: 400, body: { error: "missing X-GitHub-Delivery" } };
  const fresh = deps.db
    .insert(webhookDeliveries)
    .values({ id: req.deliveryId, receivedAt: Date.now() })
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id })
    .all();
  if (fresh.length === 0) return { status: 200, body: { ok: true, duplicate: true } };
  if (req.event !== "pull_request") return { status: 202, body: { ok: true, runIds: [] } };

  let payload: PullRequestEvent;
  try {
    const parsed = PullRequestEvent.safeParse(JSON.parse(req.body));
    if (!parsed.success) {
      console.warn(`[webhook] ${req.deliveryId}: unexpected pull_request payload: ${parsed.error.issues[0]?.message}`);
      return { status: 202, body: { ok: true, runIds: [] } };
    }
    payload = parsed.data;
  } catch {
    return { status: 202, body: { ok: true, runIds: [] } };
  }

  const created = createPullRequestRuns(deps, payload);
  for (const { runId, awaiting } of created) deps.checks.createCheckRun(runId, awaiting);
  if (created.length > 0) deps.scheduler.kick();
  return { status: 202, body: { ok: true, runIds: created.map((c) => c.runId) } };
}

function createPullRequestRuns(deps: AppDeps, ev: PullRequestEvent): { runId: string; awaiting: boolean }[] {
  const { db } = deps;
  const pr = ev.pull_request;
  const repo = ev.repository.full_name;
  const headSha = pr.head.sha;
  const sha7 = headSha.slice(0, 7);
  const untrustedSource = isUntrustedPullSource(pr.head.repo?.full_name, pr.base.repo.full_name, pr.author_association);
  const out: { runId: string; awaiting: boolean }[] = [];

  for (const flow of db.select().from(flows).all()) {
    const trigger = flow.definition.trigger;
    const prDef = pullRequestInputOf(flow.definition);
    if (trigger.kind !== "github_pull_request" || !prDef) continue;
    if (!trigger.events.some((e) => e === ev.action)) continue;
    if (!trigger.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) continue;

    const dedupeKey = `gh:${flow.id}:${repo}:${pr.number}:${headSha}`;
    if (db.select({ id: runs.id }).from(runs).where(eq(runs.dedupeKey, dedupeKey)).get()) continue;

    // Supersede older non-terminal runs of this flow for the same PR at another head.
    const older = db
      .select()
      .from(runs)
      .where(
        and(eq(runs.flowId, flow.id), eq(runs.triggerKind, "github"), inArray(runs.status, [...PENDING_STATUSES, ...ACTIVE_STATUSES])),
      )
      .all()
      .filter((r) => r.github && r.github.repo === repo && r.github.number === pr.number && r.github.headSha !== headSha);
    for (const old of older) {
      const reason = `Superseded by ${sha7}`;
      db.update(runs).set({ error: reason }).where(eq(runs.id, old.id)).run();
      if (PENDING_STATUSES.includes(old.status)) deps.runs.terminate(old.id, "cancelled", reason);
      else deps.runs.cancel(old.id);
      console.log(`[webhook] run ${old.id} superseded by ${sha7}`);
    }

    const status = initialPullRunStatus(trigger, untrustedSource);
    if (status === null) continue;

    // Other inputs are optional on PR-triggered flows (validateFlow); leave them empty.
    const inputs: Record<string, unknown> = {};
    for (const d of flow.definition.inputs) inputs[d.key] = d.type === "text" ? "" : null;
    inputs[prDef.key] = pullRequestInput({
      url: pr.html_url,
      repo,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      baseSha: pr.base.sha,
      headSha,
      untrustedSource,
    });
    const id = insertRun(deps, flow, inputs, {
      ...(ev.installation ? { installationId: ev.installation.id } : {}),
      dedupeKey,
      status,
      triggerKind: "github",
    });
    if (id === null) continue;
    console.log(`[webhook] ${repo}#${pr.number}@${sha7} (${ev.action}) → run ${id} (${status}) for flow ${flow.name}`);
    out.push({ runId: id, awaiting: status === "awaiting_approval" });
  }
  return out;
}
