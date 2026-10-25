import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RunEvent, RunEventDraft, RunnerMessage } from "@orch/protocol";

export const FLUSH_INTERVAL_MS = 50;
export const MAX_BATCH = 200;
/** Serialized size cap of one `job.events` batch; Bun's server WebSocket rejects frames over 16 MiB. */
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
/** Serialized size cap of one event; strings inside a larger event are cut until it fits. */
export const MAX_EVENT_BYTES = 1024 * 1024;
export const TRUNCATED_MARK = "\n… (truncated)";
/** Strings up to this length are never cut (ids, type literals, statuses). */
const MIN_STRING_CAP = 1024;

const COALESCIBLE = ["agent_message_chunk", "agent_thought_chunk"];

/** Last appended, not-yet-flushed event of a run when it can absorb further text chunks. */
interface CoalesceTail {
  seq: number;
  event: RunEvent;
  text: string;
}

interface TextChunk {
  sessionUpdate: string;
  messageId: unknown;
  text: string;
}

function textChunk(event: RunEvent | RunEventDraft): TextChunk | null {
  if (event.type !== "acp.update") return null;
  const update = event.payload.update;
  if (!COALESCIBLE.includes(update.sessionUpdate)) return null;
  const content = update.content;
  if (!content || typeof content !== "object" || !("type" in content) || content.type !== "text") return null;
  if (!("text" in content) || typeof content.text !== "string") return null;
  return { sessionUpdate: update.sessionUpdate, messageId: update.messageId ?? null, text: content.text };
}

/** `value` with every string longer than `max` chars cut to `max` plus {@link TRUNCATED_MARK}. */
function capStrings(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    if (value.length <= max) return value;
    const code = value.charCodeAt(max - 1);
    // Never split a surrogate pair.
    return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max) + TRUNCATED_MARK;
  }
  if (Array.isArray(value)) return value.map((v) => capStrings(v, max));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capStrings(v, max)]));
  }
  return value;
}

function longestString(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || typeof value !== "object") return 0;
  let max = 0;
  for (const v of Object.values(value)) max = Math.max(max, longestString(v));
  return max;
}

/**
 * JSON of `event` within {@link MAX_EVENT_BYTES}: an oversized event keeps its shape, with its long
 * strings cut to the largest common length that fits, so no event can exceed a WebSocket frame.
 */
function serialize(event: RunEvent): string {
  const json = JSON.stringify(event);
  if (Buffer.byteLength(json) <= MAX_EVENT_BYTES) return json;
  let lo = MIN_STRING_CAP;
  let hi = longestString(event);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(JSON.stringify(capStrings(event, mid))) <= MAX_EVENT_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return JSON.stringify(capStrings(event, lo));
}

/**
 * Durable per-runner event outbox. Assigns per-run monotonic `seq`, coalesces streaming text chunks
 * within one flush window, and sends `job.events` batches until the server acks them.
 */
export class Outbox {
  private readonly db: Database;
  /** Highest seq already handed to `send` (per run) since the last replay. */
  private readonly sentUpTo = new Map<string, number>();
  private readonly tails = new Map<string, CoalesceTail>();
  /** Runs with rows appended since the last flush. */
  private readonly dirty = new Set<string>();
  private timer: Timer | undefined;

  constructor(
    dbPath: string,
    private readonly send: (msg: RunnerMessage) => void,
  ) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (run_id, seq))",
    );
    // Survives acks (which delete rows) so seq stays monotonic per run.
    this.db.run("CREATE TABLE IF NOT EXISTS run_seq (run_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)");
    for (const { run_id } of this.db.query<{ run_id: string }, []>("SELECT DISTINCT run_id FROM events").all()) {
      this.dirty.add(run_id);
    }
  }

  append(draft: RunEventDraft): void {
    const runId = draft.runId;
    const incoming = { ...draft, ts: draft.ts ?? Date.now() };
    const tail = this.tails.get(runId);
    const chunk = textChunk(incoming);

    if (tail && chunk) {
      const prev = textChunk(tail.event);
      if (
        prev &&
        prev.sessionUpdate === chunk.sessionUpdate &&
        prev.messageId === chunk.messageId &&
        tail.event.stepId === draft.stepId
      ) {
        const text = tail.text + chunk.text;
        const merged = this.withText(tail.event, text);
        const json = JSON.stringify(merged);
        // A merge that would outgrow the event cap starts a new event instead.
        if (Buffer.byteLength(json) <= MAX_EVENT_BYTES) {
          tail.text = text;
          tail.event = merged;
          this.db.run("UPDATE events SET json = ? WHERE run_id = ? AND seq = ?", [json, runId, tail.seq]);
          return;
        }
      }
    }

    const event = this.db.transaction((): RunEvent => {
      const row = this.db
        .query<{ last_seq: number }, [string]>("SELECT last_seq FROM run_seq WHERE run_id = ?")
        .get(runId);
      const seq = (row?.last_seq ?? 0) + 1;
      // Unchecked: `incoming` is a RunEventDraft of the same variant; adding seq yields that RunEvent variant.
      const ev = { ...incoming, seq } as RunEvent;
      this.db.run(
        "INSERT INTO run_seq (run_id, last_seq) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET last_seq = excluded.last_seq",
        [runId, seq],
      );
      this.db.run("INSERT INTO events (run_id, seq, json) VALUES (?, ?, ?)", [runId, seq, serialize(ev)]);
      return ev;
    })();

    if (chunk) this.tails.set(runId, { seq: event.seq, event, text: chunk.text });
    else this.tails.delete(runId);
    this.dirty.add(runId);
  }

  private withText(event: RunEvent, text: string): RunEvent {
    if (event.type !== "acp.update") return event;
    const update = event.payload.update;
    const content = update.content && typeof update.content === "object" ? update.content : {};
    return { ...event, payload: { ...event.payload, update: { ...update, content: { ...content, text } } } };
  }

  pending(runId: string, afterSeq: number): RunEvent[] {
    return this.rows(runId, afterSeq).map((r) => JSON.parse(r.json) as RunEvent);
  }

  private rows(runId: string, afterSeq: number): Array<{ json: string }> {
    return this.db
      .query<{ json: string }, [string, number]>("SELECT json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq")
      .all(runId, afterSeq);
  }

  ack(runId: string, seq: number): void {
    this.db.run("DELETE FROM events WHERE run_id = ? AND seq <= ?", [runId, seq]);
    if ((this.sentUpTo.get(runId) ?? 0) < seq) this.sentUpTo.set(runId, seq);
    const tail = this.tails.get(runId);
    if (tail && tail.seq <= seq) this.tails.delete(runId);
  }

  /** Re-sends everything still pending (after `welcome`). */
  replayAll(): void {
    this.sentUpTo.clear();
    for (const { run_id } of this.db.query<{ run_id: string }, []>("SELECT DISTINCT run_id FROM events").all()) {
      this.dirty.add(run_id);
    }
    this.flush();
  }

  /** Sends unsent pending events as `job.events` batches of at most MAX_BATCH events and MAX_BATCH_BYTES. */
  flush(): void {
    // Anything flushed is on the wire: it can no longer absorb chunks.
    this.tails.clear();
    const runs = [...this.dirty];
    this.dirty.clear();
    for (const runId of runs) {
      let batch: RunEvent[] = [];
      let bytes = 0;
      const sendBatch = () => {
        this.send({ t: "job.events", runId, events: batch });
        this.sentUpTo.set(runId, batch[batch.length - 1].seq);
        batch = [];
        bytes = 0;
      };
      for (const { json } of this.rows(runId, this.sentUpTo.get(runId) ?? 0)) {
        const size = Buffer.byteLength(json);
        if (batch.length > 0 && (batch.length >= MAX_BATCH || bytes + size > MAX_BATCH_BYTES)) sendBatch();
        batch.push(JSON.parse(json) as RunEvent);
        bytes += size;
      }
      if (batch.length > 0) sendBatch();
    }
  }

  start(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  close(): void {
    this.stop();
    this.db.close();
  }
}
