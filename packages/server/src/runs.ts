import { TERMINAL_STATUSES, type RunEvent, type RunStatus } from "@orch/protocol";
import { and, eq, max, type ExtractTablesWithRelations } from "drizzle-orm";
import type { SQLiteBunTransaction } from "drizzle-orm/bun-sqlite/session";
import { schema, type Db } from "./db";
import type { Hub } from "./hub";

const { runs, runSteps, runEvents, findings } = schema;

type Tx = SQLiteBunTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
type RunRecord = typeof schema.runs.$inferSelect;

export const isTerminal = (s: RunStatus): boolean => TERMINAL_STATUSES.includes(s);

export type CancelOutcome = "not_found" | "already_terminal" | "cancelled" | "requested";

/** How long a runner gets to report a requested cancel before the server marks the run cancelled itself. */
export const CANCEL_GRACE_MS = 30_000;

/** Persistence + projection of run events, and server-side run state changes. */
export class RunService {
  private readonly cancelTimers = new Map<string, Timer>();

  constructor(
    readonly db: Db,
    readonly hub: Hub,
  ) {}

  get(runId: string): RunRecord | undefined {
    return this.db.select().from(runs).where(eq(runs.id, runId)).get();
  }

  maxSeq(runId: string): number {
    const row = this.db.select({ seq: max(runEvents.seq) }).from(runEvents).where(eq(runEvents.runId, runId)).get();
    return row?.seq ?? 0;
  }

  /**
   * Inserts runner events (duplicates by `(runId, seq)` ignored), projects and broadcasts the new ones.
   * Returns the highest seq in the batch (persisted either now or earlier), for `job.ack`.
   */
  ingest(runId: string, events: RunEvent[]): number {
    const fresh = this.db.transaction((tx) => {
      const out: RunEvent[] = [];
      for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
        const inserted = tx
          .insert(runEvents)
          .values({ runId, seq: ev.seq, ts: ev.ts, stepId: ev.stepId ?? null, type: ev.type, payload: ev.payload })
          .onConflictDoNothing()
          .returning({ seq: runEvents.seq })
          .all();
        if (inserted.length === 0) continue;
        this.project(tx, ev);
        out.push(ev);
      }
      return out;
    });
    for (const ev of fresh) {
      if (ev.type === "run.status" && isTerminal(ev.payload.status)) this.clearCancelTimer(runId);
      this.hub.publish(ev);
    }
    return events.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  /** Server-originated `run.status` for a terminal transition the runner will not report (reject, lost, offline cancel). */
  terminate(runId: string, status: "failed" | "cancelled", error?: string): void {
    this.clearCancelTimer(runId);
    const run = this.get(runId);
    if (!run || isTerminal(run.status)) return;
    const ev: RunEvent = {
      runId,
      seq: this.maxSeq(runId) + 1,
      ts: Date.now(),
      type: "run.status",
      payload: error === undefined ? { status } : { status, error },
    };
    this.ingest(runId, [ev]);
  }

  /** `job.finished`: make the run terminal without inventing an event (the runner's final events may still be in flight). */
  finish(runId: string, status: RunStatus, error?: string): void {
    this.clearCancelTimer(runId);
    const run = this.get(runId);
    if (!run || isTerminal(run.status)) return;
    const final: RunStatus = isTerminal(status) ? status : "failed";
    const err = error ?? (final === status ? undefined : `runner finished with non-terminal status ${status}`);
    this.db.transaction((tx) => this.markTerminal(tx, run, final, Date.now(), err));
  }

  /**
   * Runs without a live runner are cancelled immediately. Otherwise the holding runner gets `job.cancel`
   * and reports the outcome; if it has not within the grace period, the server marks the run cancelled.
   */
  cancel(runId: string): CancelOutcome {
    const run = this.get(runId);
    if (!run) return "not_found";
    if (isTerminal(run.status)) return "already_terminal";
    if (run.runnerId === null || !this.hub.sendToRunner(run.runnerId, { t: "job.cancel", runId })) {
      this.terminate(runId, "cancelled");
      return "cancelled";
    }
    if (!this.cancelTimers.has(runId)) {
      const timer = setTimeout(() => {
        this.cancelTimers.delete(runId);
        this.terminate(runId, "cancelled", "runner did not confirm cancellation");
      }, CANCEL_GRACE_MS);
      this.cancelTimers.set(runId, timer);
    }
    return "requested";
  }

  private clearCancelTimer(runId: string): void {
    clearTimeout(this.cancelTimers.get(runId));
    this.cancelTimers.delete(runId);
  }

  private project(tx: Tx, ev: RunEvent): void {
    switch (ev.type) {
      case "run.status": {
        const run = tx.select().from(runs).where(eq(runs.id, ev.runId)).get();
        if (!run) return;
        const { status, error, workspace } = ev.payload;
        // The workspace outlives status changes: it is where the modified code sits for review,
        // so late events (after job.finished marked the run terminal) still record it. First one wins.
        if (run.workspace === null && workspace !== undefined) {
          tx.update(runs).set({ workspace }).where(eq(runs.id, run.id)).run();
        }
        if (isTerminal(run.status)) return;
        if (isTerminal(status)) {
          this.markTerminal(tx, run, status, ev.ts, error);
          return;
        }
        tx.update(runs)
          .set({ status, ...(status === "running" && run.startedAt === null ? { startedAt: ev.ts } : {}) })
          .where(eq(runs.id, run.id))
          .run();
        return;
      }
      case "step.started":
      case "step.finished": {
        if (ev.stepId === undefined) return;
        const fields =
          ev.type === "step.started"
            ? { status: "running" as const, startedAt: ev.ts }
            : {
                status: ev.payload.status,
                output: ev.payload.output ?? null,
                structured: ev.payload.structured ?? null,
                finishedAt: ev.ts,
              };
        const run = tx.select({ definition: runs.definition }).from(runs).where(eq(runs.id, ev.runId)).get();
        const idx = run ? run.definition.steps.findIndex((s) => s.id === ev.stepId) : -1;
        tx.insert(runSteps)
          .values({ runId: ev.runId, stepId: ev.stepId, idx, ...fields })
          .onConflictDoUpdate({ target: [runSteps.runId, runSteps.stepId], set: fields })
          .run();
        return;
      }
      case "finding": {
        const f = ev.payload;
        tx.insert(findings)
          .values({
            runId: ev.runId,
            stepId: ev.stepId ?? "",
            file: f.file,
            line: f.line,
            endLine: f.endLine ?? null,
            severity: f.severity,
            message: f.message,
            ruleId: f.ruleId ?? null,
          })
          .run();
        return;
      }
      case "intervention.resolved": {
        const steps = ev.payload.steps;
        if (ev.payload.action !== "continue" || !steps?.length) return;
        const run = tx.select({ definition: runs.definition }).from(runs).where(eq(runs.id, ev.runId)).get();
        if (!run) return;
        const defSteps = run.definition.steps;
        const at = defSteps.findIndex((s) => s.id === ev.stepId);
        if (at < 0 || steps.some((s) => defSteps.some((d) => d.id === s.id))) return;
        tx.update(runs)
          .set({ definition: { ...run.definition, steps: [...defSteps.slice(0, at + 1), ...steps, ...defSteps.slice(at + 1)] } })
          .where(eq(runs.id, ev.runId))
          .run();
        return;
      }
      default:
        return;
    }
  }

  private markTerminal(tx: Tx, run: RunRecord, status: RunStatus, ts: number, error: string | undefined): void {
    tx.update(runs)
      .set({ status, finishedAt: ts, ...(error === undefined ? {} : { error }) })
      .where(eq(runs.id, run.id))
      .run();
    // A step still marked running was interrupted. Late `step.finished` events from the runner still overwrite this.
    if (status === "succeeded") return;
    tx.update(runSteps)
      .set({ status: status === "cancelled" ? "cancelled" : "failed", finishedAt: ts })
      .where(and(eq(runSteps.runId, run.id), eq(runSteps.status, "running")))
      .run();
  }
}
