// Manager runs (task agents, issue #34): inbox queue + turn-prompt rendering + the manager loop.
// The loop reuses runJob's `agentTurn` for every turn (via `ManagerLoopHost.turn`), so model switches,
// cancel handling and transcript streaming keep working; it replaces only the step loop. Inbox items
// arrive at-least-once (`manager.inbox` is re-sent until `manager.consumed`), so everything is deduped by seq.
import { escapeTags, ORCH_EVENT_TAG, type TaskMessage } from "@orch/protocol";

/** Idle exit: the manager ends `succeeded` after this long without inbox items; the server respawns it. */
export const MANAGER_IDLE_MS = 30 * 60_000;

/** The events the loop emits; job.ts envelopes them with runId/ts and the `manager` stepId. */
export type ManagerEvent =
  | { type: "step.started"; payload: { iteration?: number } }
  | { type: "step.finished"; payload: { status: "succeeded" | "failed" | "cancelled"; output?: string; error?: string } }
  | { type: "manager.reply"; payload: { text: string } }
  | { type: "manager.consumed"; payload: { upToSeq: number } };

/** What one agent turn reports back to the loop: the reply text and whether the run was cancelled during it. */
export interface ManagerTurn {
  text: string;
  cancelled: boolean;
}

/** Callbacks the loop needs from runJob. */
export interface ManagerLoopHost {
  /** Emits under the `manager` step (runId/ts/stepId envelopes already applied). */
  emit(body: ManagerEvent): void;
  /** One prompt turn in the manager's ACP session. Throws on failure; `cancelled` on cancel. */
  turn(prompt: string): Promise<ManagerTurn>;
  /** Run cancel signal. */
  signal: AbortSignal;
}

/**
 * Per-manager-run inbox. `push` buffers items even before the loop starts (at-least-once delivery: the
 * server may send the inbox ahead of or during setup); `drain` empties it in seq order.
 */
export class ManagerInbox {
  private readonly queued: TaskMessage[] = [];
  private highest = 0;
  private wake: (() => void) | null = null;

  /** Queues `items`, dropping every `seq` already seen, including repeats within this same batch. */
  push(items: TaskMessage[]): void {
    const fresh: TaskMessage[] = [];
    const accepted = new Set<number>();
    for (const m of items) {
      if (m.seq <= this.highest || accepted.has(m.seq)) continue;
      accepted.add(m.seq);
      fresh.push(m);
    }
    if (fresh.length === 0) return;
    this.queued.push(...fresh);
    // Raised to the max seen seq, past any gaps: the server re-sends unconsumed items, so a skipped
    // seq must not wedge the dedupe (a resent backlog arrives complete).
    this.highest = Math.max(this.highest, ...accepted);
    this.queued.sort((a, b) => a.seq - b.seq);
    this.wake?.();
    this.wake = null;
  }

  /** Returns and clears the queued items (the caller consumes them by emitting `manager.consumed`). */
  drain(): TaskMessage[] {
    return this.queued.splice(0);
  }

  /** Resolves when items arrive, after `timeoutMs`, or when `signal` aborts — whichever comes first. */
  async wait(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (this.queued.length > 0 || signal.aborted) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, timeoutMs);
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    // Assigned before the re-check below: a push landing in between must not be lost.
    this.wake = resolve;
    if (this.queued.length > 0) resolve();
    try {
      await promise;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      this.wake = null;
    }
  }
}

/**
 * Renders one turn's inbox batch: user text verbatim (choice answers as a pick line), events as one
 * compact element each. The manager's own (`manager`) messages are never re-fed into its prompt.
 */
export function renderInbox(items: TaskMessage[]): string {
  const parts: string[] = [];
  for (const m of items) {
    if (m.role === "user") {
      parts.push(m.answerTo !== undefined ? `User picked "${m.choice ?? ""}" for question #${m.answerTo}` : m.text);
    } else if (m.role === "event") {
      const run = m.runId !== undefined ? ` run="${m.runId}"` : "";
      // Event text quotes child runs: an `</orch_event>` inside it must not end the element early (what followed
      // would read as the manager's own instructions). The server already neutralised it inside untrusted parts.
      const text = escapeTags(m.text, [ORCH_EVENT_TAG]);
      parts.push(`<${ORCH_EVENT_TAG} seq="${m.seq}" kind="${m.event ?? "note"}"${run}>${text}</${ORCH_EVENT_TAG}>`);
    }
  }
  return parts.join("\n\n");
}

export interface ManagerLoopResult {
  status: "succeeded" | "failed" | "cancelled";
  error?: string;
}

/**
 * Runs the manager loop: a first turn rehydrating from the system prompt + brief + anything already
 * buffered, then one turn per inbox batch until the batch is empty after `idleMs` (idle exit) or the
 * run is cancelled. Emits `manager.reply` (non-empty replies) and `manager.consumed` (the batch's
 * highest seq, so the server stops re-sending) after every turn.
 */
export async function runManagerLoop(
  systemPrompt: string,
  brief: string,
  inbox: ManagerInbox,
  host: ManagerLoopHost,
  idleMs: number,
): Promise<ManagerLoopResult> {
  const { emit } = host;
  emit({ type: "step.started", payload: {} });

  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  /**
   * One turn over `items`; `upToSeq` 0 for the itemless first turn (nothing is being acked). Only a completed
   * turn acks its items: a cancelled one did not act on them, so they stay in the server's inbox for the next manager.
   */
  const turnOnce = async (text: string, items: TaskMessage[]): Promise<ManagerTurn> => {
    const res = await host.turn(text);
    if (res.text.trim()) emit({ type: "manager.reply", payload: { text: res.text } });
    if (!res.cancelled) emit({ type: "manager.consumed", payload: { upToSeq: items.reduce((max, m) => Math.max(max, m.seq), 0) } });
    return res;
  };

  let error: string | undefined;
  let cancelled = false;
  let lastReply = "";
  try {
    const first = inbox.drain();
    const firstPrompt = `${systemPrompt}\n\n${brief}${first.length > 0 ? `\n\n${renderInbox(first)}` : ""}`;
    let turn = await turnOnce(firstPrompt, first);
    lastReply = turn.text;
    while (!turn.cancelled) {
      await inbox.wait(host.signal, idleMs);
      if (host.signal.aborted) {
        cancelled = true;
        break;
      }
      const items = inbox.drain();
      if (items.length === 0) break; // idle timeout: the server respawns on the next inbox item
      turn = await turnOnce(renderInbox(items), items);
      lastReply = turn.text;
    }
    if (turn.cancelled) cancelled = true;
  } catch (err) {
    if (host.signal.aborted) cancelled = true;
    else error = errorText(err);
  }

  if (error !== undefined) {
    emit({ type: "step.finished", payload: { status: "failed", error } });
    return { status: "failed", error };
  }
  if (cancelled) {
    emit({ type: "step.finished", payload: { status: "cancelled" } });
    return { status: "cancelled" };
  }
  emit({ type: "step.finished", payload: { status: "succeeded", ...(lastReply.trim() ? { output: lastReply } : {}) } });
  return { status: "succeeded" };
}
