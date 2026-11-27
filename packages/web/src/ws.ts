import { RunEvent, TaskStreamItem, TERMINAL_STATUSES } from "@orch/protocol";
import { useEffect, useState } from "react";
import { redirectToLogin } from "./api";

/** Close code the server uses when the browser has no valid session. */
const WS_UNAUTHORIZED = 4401;
/** Close code for a stream whose subject (here: the task) does not exist; reconnecting cannot help. */
const WS_NOT_FOUND = 4404;

const MAX_BACKOFF_MS = 10_000;

/**
 * Live run event stream over `GET /api/runs/:id/stream?afterSeq=N`.
 * Tracks the last seq, drops duplicates, and reconnects from the last seq with backoff.
 * Batches delivered events per animation frame so token streams don't re-render per frame.
 * After a terminal `run.status` it still reconnects, but only every `MAX_BACKOFF_MS`, so a later retry's events arrive.
 */
export class RunEventStream {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private backoff = 1000;
  private timer: number | undefined;
  private pending: RunEvent[] = [];
  private frame: number | null = null;
  private terminal = false;
  private closed = false;

  constructor(
    private readonly runId: string,
    private readonly onEvents: (events: RunEvent[]) => void,
    private readonly onConnected: (connected: boolean) => void,
  ) {
    this.connect();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.ws?.close();
  }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/api/runs/${encodeURIComponent(this.runId)}/stream?afterSeq=${this.lastSeq}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.onConnected(true);
    };
    ws.onmessage = (msg) => {
      if (typeof msg.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(msg.data);
      } catch {
        return;
      }
      // Each message is an array of events: the replayed backlog in one message, then live events.
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const parsed = RunEvent.safeParse(item);
        if (!parsed.success) continue;
        const ev = parsed.data;
        if (ev.seq <= this.lastSeq) continue;
        this.lastSeq = ev.seq;
        if (ev.type === "run.status") {
          // A retried run re-enters queued: back to normal reconnect backoff.
          this.terminal = TERMINAL_STATUSES.includes(ev.payload.status);
        }
        this.pending.push(ev);
      }
      if (this.pending.length > 0 && this.frame === null) this.frame = requestAnimationFrame(() => this.flush());
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onConnected(false);
      if (this.closed) return;
      if (ev.code === WS_UNAUTHORIZED) {
        this.closed = true;
        return redirectToLogin();
      }
      if (this.terminal) {
        this.timer = window.setTimeout(() => this.connect(), MAX_BACKOFF_MS);
        return;
      }
      this.timer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
  }

  private flush(): void {
    this.frame = null;
    if (this.closed || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.onEvents(batch);
  }
}

/** Subscribes to a run's event stream for the lifetime of the component; `onEvents` must be stable. */
export function useRunEventStream(runId: string, onEvents: (events: RunEvent[]) => void): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const stream = new RunEventStream(runId, onEvents, setConnected);
    return () => stream.close();
  }, [runId, onEvents]);
  return connected;
}

/**
 * Live task stream over `GET /api/tasks/:id/stream?afterSeq=N`.
 * `afterSeq` counts task *messages*: the backlog re-sends them from there (deduped by seq), while `task`,
 * `run` items always carry the full current row and `manager` items are live-only, so replaying them is safe.
 */
export class TaskStream {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private backoff = 1000;
  private timer: number | undefined;
  private pending: TaskStreamItem[] = [];
  private frame: number | null = null;
  private closed = false;

  constructor(
    private readonly taskId: string,
    private readonly onItems: (items: TaskStreamItem[]) => void,
    private readonly onConnected: (connected: boolean) => void,
  ) {
    this.connect();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.ws?.close();
  }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/api/tasks/${encodeURIComponent(this.taskId)}/stream?afterSeq=${this.lastSeq}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.onConnected(true);
    };
    ws.onmessage = (msg) => {
      if (typeof msg.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(msg.data);
      } catch {
        return;
      }
      // Each message is an array of items: the replayed backlog in one message, then live items.
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const parsed = TaskStreamItem.safeParse(item);
        if (!parsed.success) continue;
        const it = parsed.data;
        // Messages dedupe by seq; a `manager` frame is live-only (never replayed), so keep it out of
        // the seq ledger: its event seq belongs to the run's own log, not the task message log.
        if (it.t === "message") {
          if (it.message.seq <= this.lastSeq) continue;
          this.lastSeq = it.message.seq;
        }
        this.pending.push(it);
      }
      if (this.pending.length > 0 && this.frame === null) this.frame = requestAnimationFrame(() => this.flush());
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onConnected(false);
      if (this.closed) return;
      if (ev.code === WS_UNAUTHORIZED) {
        this.closed = true;
        return redirectToLogin();
      }
      if (ev.code === WS_NOT_FOUND) {
        this.closed = true;
        return;
      }
      this.timer = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
  }

  private flush(): void {
    this.frame = null;
    if (this.closed || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.onItems(batch);
  }
}

/** Subscribes to a task's stream for the lifetime of the component; `onItems` must be stable. */
export function useTaskStream(taskId: string, onItems: (items: TaskStreamItem[]) => void): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const stream = new TaskStream(taskId, onItems, setConnected);
    return () => stream.close();
  }, [taskId, onItems]);
  return connected;
}
