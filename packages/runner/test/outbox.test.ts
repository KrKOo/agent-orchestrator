import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunEventDraft, RunnerMessage } from "@orch/protocol";
import { MAX_BATCH, MAX_BATCH_BYTES, MAX_EVENT_BYTES, Outbox, TRUNCATED_MARK } from "../src/outbox";

type JobEvents = Extract<RunnerMessage, { t: "job.events" }>;

let dir: string;
let sent: RunnerMessage[];
let outbox: Outbox;

const chunk = (text: string, stepId = "s1", sessionUpdate = "agent_message_chunk"): RunEventDraft => ({
  runId: "r1",
  ts: 1,
  stepId,
  type: "acp.update",
  payload: { update: { sessionUpdate, content: { type: "text", text } } },
});

const log = (text: string): RunEventDraft => ({
  runId: "r1",
  ts: 1,
  type: "sandbox.log",
  payload: { stream: "stderr", text },
});

function sentEvents(): RunEvent[] {
  return sent.filter((m): m is JobEvents => m.t === "job.events").flatMap((m) => m.events);
}

function textOf(e: RunEvent): unknown {
  return e.type === "acp.update" ? e.payload.update.content : e.payload;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbox-"));
  sent = [];
  outbox = new Outbox(join(dir, "outbox.sqlite"), (m) => sent.push(m));
});

afterEach(() => {
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Outbox", () => {
  test("append assigns contiguous per-run seq and flush sends them", () => {
    outbox.append(log("a"));
    outbox.append(log("b"));
    outbox.append({ ...log("x"), runId: "r2" });
    outbox.flush();
    expect(sentEvents().map((e) => [e.runId, e.seq])).toEqual([
      ["r1", 1],
      ["r1", 2],
      ["r2", 1],
    ]);
    // Nothing new → nothing re-sent.
    sent = [];
    outbox.flush();
    expect(sent).toEqual([]);
  });

  test("ack deletes rows and seq stays monotonic after ack", () => {
    outbox.append(log("a"));
    outbox.append(log("b"));
    outbox.flush();
    outbox.ack("r1", 2);
    expect(outbox.pending("r1", 0)).toEqual([]);
    outbox.append(log("c"));
    expect(outbox.pending("r1", 0).map((e) => e.seq)).toEqual([3]);
  });

  test("replay after simulated reconnect resends only unacked events, seq contiguous", () => {
    for (let i = 0; i < 5; i++) outbox.append(log(`l${i}`));
    outbox.flush(); // sent while "connected"
    outbox.ack("r1", 2); // server persisted 1..2 before the link dropped
    // Disconnected: sends are dropped.
    outbox.append(log("l5"));
    outbox.flush();

    // Runner restarts: a fresh Outbox on the same file keeps state.
    outbox.close();
    sent = [];
    outbox = new Outbox(join(dir, "outbox.sqlite"), (m) => sent.push(m));
    outbox.ack("r1", 3); // welcome.lastAckedSeq
    outbox.replayAll();
    const seqs = sentEvents().map((e) => e.seq);
    expect(seqs).toEqual([4, 5, 6]);
    outbox.append(log("l6"));
    outbox.flush();
    expect(sentEvents().map((e) => e.seq)).toEqual([4, 5, 6, 7]);
  });

  test("disconnect mid-run: server ends with contiguous seqs and the complete transcript", () => {
    // Simulated server: persists with INSERT OR IGNORE semantics, acks after each batch.
    const persisted = new Map<number, RunEvent>();
    let connected = true;
    const acks: number[] = [];
    outbox.close();
    outbox = new Outbox(join(dir, "outbox.sqlite"), (m) => {
      if (!connected || m.t !== "job.events") return; // dropped on the dead link
      for (const e of m.events) if (!persisted.has(e.seq)) persisted.set(e.seq, e);
      acks.push(Math.max(...m.events.map((e) => e.seq)));
    });
    const drainAcks = () => {
      for (const seq of acks.splice(0)) outbox.ack("r1", seq);
    };
    let expected = "";
    const emit = (text: string) => {
      expected += text;
      outbox.append(chunk(text));
    };

    for (let i = 0; i < 10; i++) emit(`a${i} `);
    outbox.flush();
    drainAcks();
    // The link drops; the job keeps streaming and every flush is lost.
    connected = false;
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 7; i++) emit(`b${round}.${i} `);
      outbox.append(log(`log ${round}`));
      outbox.flush();
    }
    // Reconnect: welcome carries the server's last persisted seq, then replay.
    connected = true;
    outbox.ack("r1", Math.max(...persisted.keys()));
    outbox.replayAll();
    drainAcks();
    for (let i = 0; i < 3; i++) emit(`c${i} `);
    outbox.flush();
    drainAcks();

    const seqs = [...persisted.keys()].sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const text = seqs
      .map((s) => persisted.get(s)!)
      .filter((e) => e.type === "acp.update")
      .map((e) => {
        const content = textOf(e);
        return content && typeof content === "object" && "text" in content ? String(content.text) : "";
      })
      .join("");
    expect(text).toBe(expected);
    expect(outbox.pending("r1", 0)).toEqual([]);
  });

  test("coalesces consecutive same-step text chunks within one flush window", () => {
    outbox.append(chunk("Hel"));
    outbox.append(chunk("lo "));
    outbox.append(chunk("world"));
    outbox.append(chunk("think", "s1", "agent_thought_chunk"));
    outbox.append(chunk("more", "s1", "agent_thought_chunk"));
    outbox.append(chunk("other step", "s2"));
    outbox.append(log("break"));
    outbox.append(chunk("after"));
    outbox.flush();
    const events = sentEvents();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.map(textOf)).toEqual([
      { type: "text", text: "Hello world" },
      { type: "text", text: "thinkmore" },
      { type: "text", text: "other step" },
      { stream: "stderr", text: "break" },
      { type: "text", text: "after" },
    ]);
  });

  test("does not merge into an already flushed event", () => {
    outbox.append(chunk("a"));
    outbox.flush();
    outbox.append(chunk("b"));
    outbox.flush();
    expect(sentEvents().map((e) => [e.seq, textOf(e)])).toEqual([
      [1, { type: "text", text: "a" }],
      [2, { type: "text", text: "b" }],
    ]);
  });

  test("does not merge chunks with different messageIds", () => {
    const withId = (text: string, messageId: string): RunEventDraft => ({
      ...chunk(text),
      type: "acp.update",
      payload: { update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } },
    });
    outbox.append(withId("a", "m1"));
    outbox.append(withId("b", "m1"));
    outbox.append(withId("c", "m2"));
    outbox.flush();
    expect(sentEvents().map(textOf)).toEqual([
      { type: "text", text: "ab" },
      { type: "text", text: "c" },
    ]);
  });

  test("batches at most MAX_BATCH events per job.events message", () => {
    for (let i = 0; i < MAX_BATCH * 2 + 5; i++) outbox.append(log(`l${i}`));
    outbox.flush();
    const batches = sent.filter((m): m is JobEvents => m.t === "job.events");
    expect(batches.map((b) => b.events.length)).toEqual([MAX_BATCH, MAX_BATCH, 5]);
    expect(sentEvents().map((e) => e.seq)).toEqual(Array.from({ length: MAX_BATCH * 2 + 5 }, (_, i) => i + 1));
  });

  test("splits batches by serialized size so no job.events frame exceeds MAX_BATCH_BYTES", () => {
    const big = "x".repeat(MAX_EVENT_BYTES / 2);
    const n = Math.ceil((MAX_BATCH_BYTES * 2) / big.length);
    for (let i = 0; i < n; i++) outbox.append(log(big));
    outbox.flush();
    const batches = sent.filter((m): m is JobEvents => m.t === "job.events");
    expect(batches.length).toBeGreaterThan(2);
    for (const b of batches) expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    expect(sentEvents().map((e) => e.seq)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  test("an oversized event is stored and sent cut to MAX_EVENT_BYTES, keeping its shape", () => {
    const output = `{"a":"${"q".repeat(MAX_EVENT_BYTES * 5)}"}\n`;
    outbox.append({ runId: "r1", ts: 1, stepId: "plan", type: "step.finished", payload: { status: "succeeded", output } });
    outbox.flush();
    const [ev] = sentEvents();
    expect(Buffer.byteLength(JSON.stringify(ev))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(ev).toMatchObject({ seq: 1, stepId: "plan", type: "step.finished", payload: { status: "succeeded" } });
    const cut = ev!.type === "step.finished" ? ev.payload.output! : "";
    expect(cut.endsWith(TRUNCATED_MARK)).toBe(true);
    expect(output.startsWith(cut.slice(0, -TRUNCATED_MARK.length))).toBe(true);
    // The largest cut that fits: well over half the cap survives despite JSON escaping.
    expect(cut.length).toBeGreaterThan(MAX_EVENT_BYTES / 4);
  });

  test("stops coalescing text chunks before the merged event outgrows MAX_EVENT_BYTES", () => {
    const part = "y".repeat(MAX_EVENT_BYTES / 3);
    for (let i = 0; i < 4; i++) outbox.append(chunk(part));
    outbox.flush();
    const events = sentEvents();
    expect(events.length).toBeGreaterThan(1);
    for (const e of events) expect(Buffer.byteLength(JSON.stringify(e))).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    const texts = events.map((e) => {
      const content = textOf(e);
      return content && typeof content === "object" && "text" in content ? String(content.text) : "";
    });
    expect(texts.join("")).toBe(part.repeat(4));
  });

  test("start() flushes on its own timer", async () => {
    const { promise, resolve } = Promise.withResolvers<RunnerMessage>();
    const timed = new Outbox(join(dir, "timed.sqlite"), resolve);
    timed.start();
    timed.append(log("a"));
    const msg = await promise;
    timed.close();
    expect(msg.t === "job.events" && msg.events.map((e) => e.seq)).toEqual([1]);
  });
});
