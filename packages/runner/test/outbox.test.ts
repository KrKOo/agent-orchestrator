import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunEventDraft, RunnerMessage } from "@orch/protocol";
import { MAX_BATCH, Outbox } from "../src/outbox";

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

  test("seed continues seq across a fresh Outbox db", () => {
    // Attempt 1 on this runner emitted seqs 1..3 and all were acked (rows gone).
    for (const t of ["a", "b", "c"]) outbox.append(log(t));
    outbox.flush();
    outbox.ack("r1", 3);
    outbox.close();
    sent = [];
    // Attempt 2, possibly after a runner restart: the server says the transcript is at seq 3, so the
    // first new event must be seq 5 (the retry's own run.status is seq 4, sent by the server).
    outbox = new Outbox(join(dir, "outbox.sqlite"), (m) => sent.push(m));
    outbox.seed("r1", 5);
    outbox.append(log("resumed"));
    outbox.flush();
    expect(sentEvents().map((e) => e.seq)).toEqual([5]);
    // Seeding lower never rewinds the counter.
    outbox.seed("r1", 2);
    outbox.append(log("later"));
    outbox.flush();
    expect(sentEvents().map((e) => e.seq)).toEqual([5, 6]);
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
