// Manager service: watches every run event (`hub.onEvent`), keeps the task projections in sync and
// delivers the manager's inbox to the runner holding its live run (issue #34).
import {
  isAgentStep,
  TASK_MESSAGE_MAX,
  wrapUntrustedData,
  type RunEvent,
  type RunStatus,
  type TaskEventKind,
} from "@orch/protocol";
import { and, asc, eq, gt, inArray, isNotNull, lt, max, sql } from "drizzle-orm";
import { schema, type Db } from "./db";
import { isTerminal } from "./runs";
import { eventRow, runRow } from "./rows";
import { childPrUrls, MANAGER_ACTIVE_STATUSES, MANAGER_STOPPED_TEXT, managerFailedText, OUTPUT_MAX, type TaskService } from "./tasks";

const { runs, runSteps, runEvents, taskMessages } = schema;

/** Text steps whose last outputs a `run_finished` event quotes (the run's result, in the agent's words). */
const QUOTED_OUTPUTS = 2;
/** Cap per quoted step output in a `run_finished` event. */
const QUOTED_OUTPUT_MAX = 1_500;

type RunRecord = typeof runs.$inferSelect;
type TaskRecord = typeof schema.tasks.$inferSelect;
type Handler = NonNullable<RunRecord["interventionHandler"]>;
type OpenRequest = Extract<RunEvent, { type: "intervention.request" | "acp.permission_request" }>;

/** Truncates agent/child text entering a task message, ending with an ellipsis when cut. */
function cut(text: string, max = OUTPUT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** One-line summary of a permission request's tool call for the manager. */
function summarizeToolCall(toolCall: unknown): string {
  if (toolCall === null || typeof toolCall !== "object") return "unknown tool";
  const t = toolCall as { title?: unknown; kind?: unknown; rawInput?: unknown };
  const title = typeof t.title === "string" ? t.title : typeof t.kind === "string" ? t.kind : "tool";
  const input = t.rawInput === undefined ? "" : ` ${cut(JSON.stringify(t.rawInput), 300)}`;
  return `${title}${input}`;
}

/** Wraps child-run detail text when the run is untrusted (the manager must treat it as data). */
function wrappedDetail(untrusted: boolean, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return untrusted ? `\n${wrapUntrustedData(trimmed)}` : `\n${trimmed}`;
}

/** The last `QUOTED_OUTPUTS` non-empty outputs of the run's agent, slash and shell steps, truncated. */
function lastOutputs(db: Db, run: RunRecord): string {
  const textSteps = new Set(
    run.definition.steps.filter((s) => isAgentStep(s) || s.kind === "slash" || s.kind === "shell").map((s) => s.id),
  );
  const outputs = db
    .select({ stepId: runSteps.stepId, output: runSteps.output })
    .from(runSteps)
    .where(and(eq(runSteps.runId, run.id), isNotNull(runSteps.output)))
    .orderBy(asc(runSteps.idx))
    .all()
    .filter((s) => textSteps.has(s.stepId) && s.output!.trim() !== "")
    .slice(-QUOTED_OUTPUTS);
  return outputs.map((s) => `[${s.stepId}] ${cut(s.output!.trim(), QUOTED_OUTPUT_MAX)}`).join("\n");
}

/** Cap for a gate question and for each session's latest output quoted in an `intervention` event. */
const QUOTED_QUESTION_MAX = 1_500;
const QUOTED_SESSION_MAX = 800;

/**
 * Details of an `intervention.request` the manager needs to answer it. The question and session outputs are
 * the run's own text, wrapped when the run is untrusted; every part is cut first so no cut drops a closing tag.
 */
function interventionDetail(ev: Extract<RunEvent, { type: "intervention.request" }>, untrusted: boolean): string {
  const sessions = ev.payload.sessions.map((s) => `${s.id} (${s.label}): ${cut(s.output, QUOTED_SESSION_MAX)}`).join("\n") || "none";
  const choices = ev.payload.choices?.map((c) => `${c.id} (${c.label})`).join(", ");
  const ids = [
    `requestId ${ev.payload.requestId}`,
    `stepId ${ev.stepId ?? ""}`,
    ...(choices !== undefined ? [`choices (continue with one): ${choices}`] : []),
    `session ids: ${ev.payload.sessions.map((s) => s.id).join(", ") || "none"}`,
  ].join("; ");
  return `${ids}${wrappedDetail(untrusted, `question: ${cut(ev.payload.message, QUOTED_QUESTION_MAX)}\nsessions:\n${sessions}`)}`;
}

/** Details of an `acp.permission_request` the manager needs to answer it. */
function permissionDetail(ev: Extract<RunEvent, { type: "acp.permission_request" }>): string {
  const options = ev.payload.options.map((o) => `${o.optionId} (${o.name})`).join(", ") || "none";
  return `requestId ${ev.payload.requestId}; tool: ${summarizeToolCall(ev.payload.toolCall)}; options: ${options}`;
}

/**
 * Projections and inbox delivery for tasks. Attached once by `app.ts`; reads are synchronous, so
 * projections cannot interleave with a REST write.
 */
export class ManagerService {
  constructor(private readonly tasks: TaskService) {}

  private get db(): Db {
    return this.tasks.db;
  }

  private get hub() {
    return this.tasks.hub;
  }

  /** Starts observing every persisted run event. */
  attach(): () => void {
    return this.hub.onEvent((ev) => this.onEvent(ev));
  }

  /**
   * Called from `ws/runner.ts` on a runner's `replayed`: re-sends the unconsumed inbox of every
   * non-terminal manager run the runner holds (at-least-once; the runner dedupes by `seq`).
   */
  onRunnerReplayed(runnerId: string): void {
    const held = this.db
      .select()
      .from(runs)
      .where(and(eq(runs.runnerId, runnerId), eq(runs.role, "manager"), inArray(runs.status, [...MANAGER_ACTIVE_STATUSES])))
      .all();
    for (const run of held) {
      const task = run.taskId ? this.tasks.get(run.taskId) : undefined;
      if (task) this.deliver(task, run);
    }
  }

  /** Delivers the whole unconsumed inbox to the runner holding the task's live manager run. */
  deliver(task: TaskRecord, run?: RunRecord): void {
    this.tasks.deliverInbox(task, run);
  }

  /** Called by the scheduler right after manager run `runId` was assigned: its inbox follows the `job.assign`. */
  onManagerAssigned(runId: string): void {
    const run = this.tasks.run(runId);
    const task = run?.taskId ? this.tasks.get(run.taskId) : undefined;
    if (run && task) this.deliver(task, run);
  }

  /**
   * Called from `ws/runner.ts` with every `job.events` batch of a run the runner holds, before `RunService.ingest`:
   * applies its `manager.consumed` acks whether or not ingest stores them. A server-made event (`RunService.terminate`,
   * e.g. `runner_lost`) takes `maxSeq + 1`, which can be the seq of an ack still in the runner's outbox; ingest would
   * drop that ack as a duplicate on replay, and the next manager would redo the batch. Acks are idempotent (the
   * cursor never moves back), so the projection in `onManagerEvent` repeating a stored one is harmless.
   */
  ackConsumed(runId: string, events: RunEvent[]): void {
    let upToSeq = 0;
    for (const ev of events) if (ev.type === "manager.consumed") upToSeq = Math.max(upToSeq, ev.payload.upToSeq);
    if (upToSeq === 0) return;
    const run = this.tasks.run(runId);
    if (run?.role === "manager" && run.taskId) this.tasks.ackInbox(run.taskId, upToSeq);
  }

  /**
   * `PUT /api/runs/:id/handler` changed worker run `runId`'s handler; `previous` is the effective handler before.
   * Publishes the run, and when the requests go back to the manager, re-delivers every request still open: the
   * manager is only told about a request when its event arrives, so one raised while the user held the run would
   * never reach it and an intervention without a timeout would wait forever.
   */
  onHandlerChanged(runId: string, previous: Handler): void {
    const run = this.tasks.run(runId);
    const task = run?.taskId ? this.tasks.get(run.taskId) : undefined;
    if (!run || !task) return;
    this.tasks.publishRun(task.id, run.id);
    const handler = run.interventionHandler ?? task.settings.interventions;
    if (previous === "manager" || handler !== "manager" || isTerminal(run.status)) return;
    for (const ev of this.openRequests(run.id)) {
      if (ev.type === "intervention.request") this.event(task, run, "intervention", interventionDetail(ev, run.trust === "untrusted"));
      else this.event(task, run, "permission", permissionDetail(ev));
    }
  }

  /**
   * The run's unanswered intervention and permission requests, oldest first. Only the current attempt counts
   * (a retry starts with the server's `run.status queued` event): an earlier attempt's requests died with it.
   */
  private openRequests(runId: string): OpenRequest[] {
    const attemptStart = this.attemptStart(runId);
    const events = this.db
      .select()
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, runId),
          gt(runEvents.seq, attemptStart),
          inArray(runEvents.type, ["intervention.request", "intervention.resolved", "acp.permission_request", "acp.permission_resolved"]),
        ),
      )
      .orderBy(asc(runEvents.seq))
      .all()
      .map(eventRow);
    const resolved = new Set(
      events.flatMap((e) => (e.type === "intervention.resolved" || e.type === "acp.permission_resolved" ? [e.payload.requestId] : [])),
    );
    return events.filter(
      (e): e is OpenRequest => (e.type === "intervention.request" || e.type === "acp.permission_request") && !resolved.has(e.payload.requestId),
    );
  }

  /** Seq of the run's last server `run.status queued` event (a retry starts a new attempt there), else 0. */
  private attemptStart(runId: string): number {
    return (
      this.db
        .select({ seq: max(runEvents.seq) })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "run.status"), sql`json_extract(${runEvents.payload}, '$.status') = 'queued'`))
        .get()?.seq ?? 0
    );
  }

  /**
   * True when the stored terminal `run.status` at `seq` is the first of the run's current attempt. A run the server
   * ended itself (`runner_lost`, cancel grace timeout, `job.rejected`) can still get the runner's own terminal event
   * later; acting on it again would repeat the outcome's notice and status change, maybe after a new manager started.
   */
  private firstTerminal(runId: string, seq: number): boolean {
    const earlier = this.db
      .select({ n: sql<number>`count(*)` })
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, runId),
          eq(runEvents.type, "run.status"),
          gt(runEvents.seq, this.attemptStart(runId)),
          lt(runEvents.seq, seq),
          sql`json_extract(${runEvents.payload}, '$.status') IN ('succeeded', 'failed', 'cancelled')`,
        ),
      )
      .get()!.n;
    return earlier === 0;
  }

  private onEvent(ev: RunEvent): void {
    try {
      this.handle(ev);
    } catch (err) {
      console.error(`[manager] event ${ev.type} for run ${ev.runId} failed:`, err);
    }
  }

  private handle(ev: RunEvent): void {
    const run = this.tasks.run(ev.runId);
    if (!run) return;
    if (run.role === "manager" && run.taskId) this.onManagerEvent(run, ev);
    else if (run.role === "worker" && run.taskId) this.onChildEvent(run, ev);
  }

  // ---- Manager run events -------------------------------------------------------------------------

  private onManagerEvent(run: RunRecord, ev: RunEvent): void {
    const task = run.taskId ? this.tasks.get(run.taskId) : undefined;
    if (!task) return;
    this.tasks.noteManagerRun(task.id, run.id);
    switch (ev.type) {
      case "manager.reply": {
        // One chat row per finished turn; `ask_user` questions arrive through the tool instead.
        this.tasks.append({ taskId: task.id, role: "manager", text: cut(ev.payload.text, TASK_MESSAGE_MAX) });
        this.stopIfDone(task.id);
        return;
      }
      case "manager.consumed": {
        this.tasks.ackInbox(task.id, ev.payload.upToSeq);
        this.stopIfDone(task.id);
        return;
      }
      case "run.status": {
        this.tasks.publish(task.id, { t: "run", run: runRow(this.tasks.run(run.id) ?? run) });
        // `run` is the stored row: `ingest` stores a whole batch before publishing it, so a `running` handled after
        // the batch's terminal status sees a finished run. Delivering then would start a new manager before the
        // batch's `manager.consumed` acks the items the finished one already handled.
        if (ev.payload.status === "running" && !isTerminal(run.status)) this.deliver(task, run);
        const status = ev.payload.status;
        if ((status === "succeeded" || status === "failed" || status === "cancelled") && this.firstTerminal(run.id, ev.seq))
          this.onManagerTerminal(task, run, status, ev.payload.error);
        return;
      }
      case "acp.update": {
        // Live transcript of the task's current manager run for the task stream; never replayed.
        this.tasks.publish(task.id, { t: "manager", event: ev });
        return;
      }
      default:
        return;
    }
  }

  /**
   * `complete_task` marks the task done mid-turn; once that turn's reply/consumed events arrive the turn is over,
   * so the manager run is stopped instead of idling until its timeout.
   */
  private stopIfDone(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task && (task.status === "done" || task.status === "archived")) this.tasks.stopManager(task);
  }

  private onManagerTerminal(task: TaskRecord, run: RunRecord, status: "succeeded" | "failed" | "cancelled", error?: string): void {
    const closing = this.tasks.takeClosingStop(run.id);
    if (status === "succeeded") {
      // Idle exit: respawn while items remain unconsumed; `ensureManager` no-ops otherwise.
      const fresh = this.tasks.get(task.id);
      if (fresh) this.tasks.ensureManager(fresh);
      return;
    }
    if (closing) {
      // Stopped because the task was finished or archived: this end is expected while the task stays closed. If the
      // user reopened or messaged it while the stop was in flight, what they sent went to this dying run, so a new
      // manager picks it up (their reopen is the go-ahead, as for a user message after a failure).
      const fresh = this.tasks.get(task.id);
      if (fresh) this.tasks.ensureManager(fresh, { byUser: true });
      return;
    }
    if (status === "failed") {
      // No respawn on failure: an id would crash-loop; the user restarts it with a message.
      this.tasks.append({ taskId: task.id, role: "manager", text: managerFailedText(error ?? "unknown error") });
      this.tasks.setNeedsInput(task.id);
      console.warn(`[manager] run ${run.id} failed for task ${task.id}: ${error ?? "unknown error"}`);
      return;
    }
    // `cancelled`, not by `stopManager`: a done/archived task needs no manager (a stop the server forgot over a
    // restart). On a live task (cancelled from the run view, runner shutdown) its unfinished items stay unconsumed;
    // respawning on our own could undo a deliberate stop, so the user decides: the next message starts a manager.
    const fresh = this.tasks.get(task.id);
    if (!fresh || fresh.status === "done" || fresh.status === "archived") return;
    this.tasks.append({ taskId: task.id, role: "manager", text: MANAGER_STOPPED_TEXT });
    this.tasks.setNeedsInput(task.id);
    console.warn(`[manager] run ${run.id} cancelled for live task ${task.id}`);
  }

  // ---- Child run events ---------------------------------------------------------------------------

  private onChildEvent(run: RunRecord, ev: RunEvent): void {
    const task = run.taskId ? this.tasks.get(run.taskId) : undefined;
    if (!task) return;
    const handler = run.interventionHandler ?? task.settings.interventions;
    if (ev.type === "run.status") {
      this.tasks.publish(task.id, { t: "run", run: runRow(this.tasks.run(run.id) ?? run) });
      if (isTerminal(ev.payload.status)) {
        if (!this.finishReported(run.id)) this.onChildTerminal(task, run, ev.payload.status, ev.payload.error);
      } else if (ev.payload.status === "awaiting_input" && handler === "user") {
        // FYI only: the user answers this one in the web UI; the manager is not asked.
        this.event(task, run, "awaiting_user", "The run is waiting for you in the web UI.");
      }
      return;
    }
    if (handler !== "manager") return;
    if (ev.type === "intervention.request") {
      this.event(task, run, "intervention", interventionDetail(ev, run.trust === "untrusted"));
      return;
    }
    if (ev.type === "acp.permission_request") {
      this.event(task, run, "permission", permissionDetail(ev));
    }
  }

  /**
   * True when the run's current attempt already has its `run_finished` message. A run the server terminated
   * itself (`runner_lost`, cancel grace timeout) can still get the runner's own terminal event later; that one
   * must not tell the manager a second, contradictory outcome. Attempts are the first one plus one per retry
   * (each retry is the server's `run.status queued` event; runners never emit `queued`).
   */
  private finishReported(runId: string): boolean {
    const retries = this.db
      .select({ n: sql<number>`count(*)` })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "run.status"), sql`json_extract(${runEvents.payload}, '$.status') = 'queued'`))
      .get()!.n;
    const reported = this.db
      .select({ n: sql<number>`count(*)` })
      .from(taskMessages)
      .where(and(eq(taskMessages.runId, runId), eq(taskMessages.event, "run_finished")))
      .get()!.n;
    return reported >= retries + 1;
  }

  private onChildTerminal(task: TaskRecord, run: RunRecord, status: RunStatus, error?: string): void {
    const parts = [`status ${status}`];
    const prs = childPrUrls(this.db, run);
    if (prs.length > 0) parts.push(`PR: ${prs.join(", ")}`);
    // The error and the step outputs are the run's own text: data for the manager, wrapped when untrusted.
    const detail = [error ? `error: ${cut(error, 1_000)}` : "", lastOutputs(this.db, run)].filter(Boolean).join("\n");
    this.event(task, run, "run_finished", `${parts.join("; ")}${wrappedDetail(run.trust === "untrusted", detail)}`);
  }

  /**
   * Appends one `event` row for the child run (which delivers the inbox). `detail` is bounded by its builders,
   * which cut each part before wrapping untrusted text, so it is never cut here.
   */
  private event(task: TaskRecord, run: RunRecord, kind: TaskEventKind, detail: string): void {
    this.tasks.append({
      taskId: task.id,
      role: "event",
      text: `${kind} for run ${run.id} "${cut(run.name ?? run.definition.name, 200)}" (flow ${run.flowId}): ${detail}`,
      runId: run.id,
      event: kind,
    });
  }
}
