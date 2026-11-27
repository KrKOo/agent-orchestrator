// Pure reducer folding a task's `TaskStreamItem` log into the view model rendered by TaskView.
// Pure like `runState.ts`: replay- and dedupe-safe, so a reconnect that repeats the backlog is a no-op.
import type { RunEvent, RunRow, TaskMessage, TaskRow, TaskStreamItem } from "@orch/protocol";

/** Live transcript of the current manager run: its `acp.update` events (live-only, never replayed). */
export interface ManagerTranscript {
  /** The manager run the transcript belongs to; items reset when the task's `managerRunId` changes. */
  runId: string;
  items: RunEvent[];
}

export interface TaskState {
  task: TaskRow | null;
  /** Chat log, ascending by seq; `seq` is unique per task, so it keys both dedupe and ordering. */
  messages: TaskMessage[];
  /** Every run seen on the stream, keyed by id; the child-run list sorts and filters on render. */
  runs: Record<string, RunRow>;
  managerTranscript: ManagerTranscript | null;
  /** Highest message seq folded; `TaskStream` reconnects from it. */
  lastSeq: number;
}

export const initialTaskState: TaskState = {
  task: null,
  messages: [],
  runs: {},
  managerTranscript: null,
  lastSeq: 0,
};

/** Folds one item; exported for tests. */
export function applyTaskItem(state: TaskState, item: TaskStreamItem): TaskState {
  switch (item.t) {
    case "message": {
      const { seq } = item.message;
      // A reconnect replays the backlog: a seq already folded is a no-op, so ordering and content stay intact.
      if (seq <= state.lastSeq && state.messages.some((m) => m.seq === seq)) return state;
      const messages = [...state.messages, item.message].sort((a, b) => a.seq - b.seq);
      return { ...state, messages, lastSeq: Math.max(state.lastSeq, seq) };
    }
    case "task":
      return withTask(state, item.task);
    case "run":
      return { ...state, runs: { ...state.runs, [item.run.id]: item.run } };
    case "manager":
      return withManagerEvent(state, item.event);
  }
}

/** The task row changed; the transcript keys off the task's `managerRunId` and resets when it changes. */
function withTask(state: TaskState, task: TaskRow): TaskState {
  if (task.managerRunId === null) return { ...state, task, managerTranscript: null };
  const prev = state.managerTranscript;
  const transcript =
    prev !== null && prev.runId === task.managerRunId ? prev : { runId: task.managerRunId, items: [] };
  return { ...state, task, managerTranscript: transcript };
}

/** Folds one live `acp.update` of the current manager run; a stale run's events are dropped. */
function withManagerEvent(state: TaskState, ev: RunEvent): TaskState {
  const transcript = state.managerTranscript;
  if (transcript === null || transcript.runId !== ev.runId) return state;
  return { ...state, managerTranscript: { runId: transcript.runId, items: [...transcript.items, ev] } };
}

/** Folds a delivered batch; skips messages already folded (`TaskStream` dedupes too, tests fold directly). */
export function applyTaskItems(state: TaskState, items: readonly TaskStreamItem[]): TaskState {
  let next = state;
  for (const item of items) next = applyTaskItem(next, item);
  return next;
}

/** The task's child (worker) runs, newest first; the manager run renders through the task row instead. */
export function childRuns(state: TaskState): RunRow[] {
  return childRunsOf(Object.values(state.runs));
}

/** `childRuns` over a plain run list (the REST `TaskDetail.runs`, which includes manager runs). */
export function childRunsOf(runs: readonly RunRow[]): RunRow[] {
  return runs.filter((r) => r.taskId !== null && r.role !== "manager").sort((a, b) => b.createdAt - a.createdAt);
}

/** Text tail of the manager transcript for the "Manager working" strip: the latest agent chunks. */
export function managerTail(state: TaskState, chars = 400): string {
  if (state.managerTranscript === null) return "";
  let text = "";
  // Newest events first: stop as soon as the tail is full.
  for (let i = state.managerTranscript.items.length - 1; i >= 0; i--) {
    const ev = state.managerTranscript.items[i]!;
    if (ev.type !== "acp.update") continue;
    const update = ev.payload.update as { sessionUpdate?: string; content?: unknown };
    if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk") continue;
    const block = update.content as { type?: string; text?: string } | undefined;
    if (block?.type !== "text" || !block.text) continue;
    text = block.text + text;
    if (text.length >= chars) break;
  }
  return text.length > chars ? text.slice(-chars) : text;
}
