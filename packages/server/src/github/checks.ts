import type { FlowDefinition, RunEvent } from "@orch/protocol";
import { asc, eq } from "drizzle-orm";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import { findingRow } from "../rows";
import type { CheckRunOutput } from "./api";
import { buildAnnotations, checkConclusion, checkSummary, checkTitle, type SummaryStep } from "./report";
import { buildReview, type ChangedFile } from "./review";
import { neutralizeMentions } from "./sanitize";

const { runs, runSteps, findings } = schema;

/** GitHub accepts at most 50 annotations per check-run update. */
export const ANNOTATIONS_PER_PATCH = 50;
export const AWAITING_APPROVAL_SUMMARY = "Awaiting approval in orchestrator";
const FINISHED_STEP = new Set(["succeeded", "failed", "cancelled"]);

export function checkNameOf(def: FlowDefinition): string {
  return def.trigger.kind === "github_pull_request" ? (def.trigger.checkName ?? def.name) : def.name;
}

type RunRecord = typeof schema.runs.$inferSelect;
type ReporterDeps = Pick<AppDeps, "config" | "db" | "runs" | "credentials" | "github">;

/**
 * Mirrors GitHub-triggered runs into their check run (and a PR review at the end).
 * GitHub calls run off the ingestion path, serialized per run so updates land in event order;
 * failures are logged and never affect the run.
 */
export class CheckReporter {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: ReporterDeps) {}

  /** Starts observing every persisted run event. */
  attach(): () => void {
    return this.deps.runs.hub.onEvent((ev) => this.onEvent(ev));
  }

  /** Resolves once every queued GitHub call has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.all(this.queues.values());
  }

  private enqueue(runId: string, what: string, task: () => Promise<void>): void {
    const prev = this.queues.get(runId) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch((err) => console.error(`[github] run ${runId}: ${what} failed:`, err instanceof Error ? err.message : err))
      .finally(() => {
        if (this.queues.get(runId) === next) this.queues.delete(runId);
      });
    this.queues.set(runId, next);
  }

  /** The run with its GitHub info and an installation token for reporting, or null when not reportable. */
  private async context(runId: string): Promise<{ run: RunRecord; repo: string; checkRunId: number; token: string } | null> {
    const run = this.deps.runs.get(runId);
    const gh = run?.github;
    if (!run || !gh || gh.checkRunId === undefined) return null;
    const token = await this.deps.credentials.tokenFor(gh.repo, "report", gh.installationId);
    return { run, repo: gh.repo, checkRunId: gh.checkRunId, token };
  }

  /** Creates the run's check run (status queued) and stores its id in `runs.github.checkRunId`. */
  createCheckRun(runId: string, awaitingApproval: boolean): void {
    if (!this.deps.credentials.configured) return;
    const run = this.deps.runs.get(runId);
    if (!run || !this.reportable(run)) return;
    this.enqueue(runId, "check run creation", async () => {
      const run = this.deps.runs.get(runId);
      const gh = run?.github;
      if (!run || !gh) return;
      const token = await this.deps.credentials.tokenFor(gh.repo, "report", gh.installationId);
      const { id } = await this.deps.github.createCheckRun(token, gh.repo, {
        name: checkNameOf(run.definition),
        head_sha: gh.headSha,
        status: "queued",
        external_id: run.id,
        details_url: `${this.deps.config.publicUrl}/runs/${run.id}`,
        ...(awaitingApproval ? { output: { title: "Awaiting approval", summary: AWAITING_APPROVAL_SUMMARY } } : {}),
      });
      // Re-read: the row may have changed while the request was in flight.
      const current = this.deps.runs.get(runId);
      if (!current?.github) return;
      this.deps.db
        .update(runs)
        .set({ github: { ...current.github, checkRunId: id } })
        .where(eq(runs.id, runId))
        .run();
    });
  }

  /** True when the run carries GitHub info and its flow wants check-run reporting. */
  private reportable(run: RunRecord): boolean {
    if (!run.github) return false;
    const trigger = run.definition.trigger;
    return trigger.kind === "github_pull_request" && trigger.postChecks !== false;
  }

  private onEvent(ev: RunEvent): void {
    if (!this.deps.credentials.configured) return;
    if (ev.type !== "run.status" && ev.type !== "step.finished") return;
    const run = this.deps.runs.get(ev.runId);
    if (!run || !this.reportable(run)) return;
    if (ev.type === "step.finished") {
      this.enqueue(run.id, "step progress update", () => this.reportProgress(run.id));
      return;
    }
    const { status } = ev.payload;
    if (status === "running") {
      this.enqueue(run.id, "in_progress update", async () => {
        const ctx = await this.context(run.id);
        if (ctx) await this.deps.github.updateCheckRun(ctx.token, ctx.repo, ctx.checkRunId, { status: "in_progress" });
      });
    } else if (status === "succeeded" || status === "failed" || status === "cancelled") {
      this.enqueue(run.id, "final report", () => this.reportFinal(run.id, status));
    }
  }

  private steps(run: RunRecord): SummaryStep[] {
    const rows = new Map(
      this.deps.db
        .select()
        .from(runSteps)
        .where(eq(runSteps.runId, run.id))
        .all()
        .map((r) => [r.stepId, r]),
    );
    return run.definition.steps.map((s) => {
      const row = rows.get(s.id);
      return { id: s.id, name: s.name, status: row?.status ?? "pending", output: row?.output ?? null };
    });
  }

  private async reportProgress(runId: string): Promise<void> {
    const ctx = await this.context(runId);
    if (!ctx) return;
    const steps = this.steps(ctx.run);
    const done = steps.filter((s) => FINISHED_STEP.has(s.status)).length;
    const output: CheckRunOutput = { title: checkTitle("succeeded", null, done, steps.length), summary: checkSummary(steps) };
    await this.deps.github.updateCheckRun(ctx.token, ctx.repo, ctx.checkRunId, { output });
  }

  private async reportFinal(runId: string, status: "succeeded" | "failed" | "cancelled"): Promise<void> {
    const ctx = await this.context(runId);
    if (!ctx) return;
    const { run, repo, checkRunId, token } = ctx;
    const gh = run.github!;
    const steps = this.steps(run);
    const done = steps.filter((s) => FINISHED_STEP.has(s.status)).length;
    const found =
      status === "cancelled"
        ? []
        : this.deps.db.select().from(findings).where(eq(findings.runId, runId)).orderBy(asc(findings.id)).all().map(findingRow);
    const files: ChangedFile[] = found.length > 0 ? await this.deps.github.listPullFiles(token, repo, gh.number) : [];
    const { annotations, outside } = buildAnnotations(found, new Set(files.map((f) => f.filename)));

    const title = checkTitle(status, run.error, done, steps.length);
    const summary = status === "cancelled" && run.error ? neutralizeMentions(run.error) : checkSummary(steps, outside);
    const batches: (typeof annotations)[] = [];
    for (let i = 0; i < annotations.length; i += ANNOTATIONS_PER_PATCH) batches.push(annotations.slice(i, i + ANNOTATIONS_PER_PATCH));
    if (batches.length === 0) batches.push([]);
    for (const [i, batch] of batches.entries()) {
      const output: CheckRunOutput = { title, summary, ...(batch.length > 0 ? { annotations: batch } : {}) };
      const last = i === batches.length - 1;
      await this.deps.github.updateCheckRun(token, repo, checkRunId, {
        output,
        ...(last ? { status: "completed", conclusion: checkConclusion(status, found), completed_at: new Date().toISOString() } : {}),
      });
    }

    const trigger = run.definition.trigger;
    if (trigger.kind !== "github_pull_request" || !trigger.postReview || found.length === 0) return;
    const review = buildReview(found, files);
    await this.deps.github.createReview(token, repo, gh.number, {
      commit_id: gh.headSha,
      event: "COMMENT",
      body: review.body,
      comments: review.comments,
    });
  }
}
