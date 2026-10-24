import { describe, expect, test } from "bun:test";
import { WIRE_PROTOCOL, type RunEvent } from "@orch/protocol";
import { eq } from "drizzle-orm";
import { schema } from "../src/db";
import { authenticateRunner, RunnerSession } from "../src/ws/runner";
import { eventsAfter } from "../src/ws/browser";
import { addRun, addRunner, caps, FakeLink, testDeps } from "./helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeps } from "../src/app";
import { parseServerConfig } from "../src/config";

function setup() {
  const deps = testDeps();
  addRunner(deps, "r1");
  const link = new FakeLink();
  const session = new RunnerSession(deps, "r1", link);
  return { deps, link, session };
}

const hello = { t: "hello", protocol: WIRE_PROTOCOL, runnerId: "r1", version: "0.1.0", capabilities: caps() } as const;

describe("runner authentication", () => {
  test("bearer token must hash to a registered runner", () => {
    const deps = testDeps();
    addRunner(deps, "r1"); // token "r1"
    expect(authenticateRunner(deps, "Bearer r1")).toBe("r1");
    expect(authenticateRunner(deps, "Bearer nope")).toBeNull();
    expect(authenticateRunner(deps, "r1")).toBeNull();
    expect(authenticateRunner(deps, undefined)).toBeNull();
  });
});

describe("RunnerSession", () => {
  test("hello stores capabilities, attaches the runner and welcomes with lastAckedSeq of held active runs", async () => {
    const { deps, link, session } = setup();
    const active = addRun(deps, { status: "running", runnerId: "r1" });
    const fresh = addRun(deps, { status: "assigned", runnerId: "r1" });
    const done = addRun(deps, { status: "succeeded", runnerId: "r1" });
    addRun(deps, { status: "running", runnerId: "other" });
    deps.runs.ingest(active, [ev(active, 1, "step.started", {}, "impl"), ev(active, 2, "sandbox.log", { stream: "stderr", text: "x" })]);
    deps.runs.ingest(done, [ev(done, 7, "sandbox.log", { stream: "stdout", text: "y" })]);

    await session.handle(JSON.stringify(hello));

    expect(link.of("welcome")).toEqual([{ t: "welcome", lastAckedSeq: { [active]: 2, [fresh]: 0 } }]);
    expect(deps.hub.isConnected("r1")).toBe(true);
    const row = deps.db.select().from(schema.runners).where(eq(schema.runners.id, "r1")).get()!;
    expect(row.capabilities?.allowedRoots).toEqual(["/Users/me/Documents"]);
    session.close();
    expect(deps.hub.isConnected("r1")).toBe(false);
  });

  test("ping answers pong and refreshes last_seen_at", async () => {
    const { deps, link, session } = setup();
    deps.db.update(schema.runners).set({ lastSeenAt: 1 }).where(eq(schema.runners.id, "r1")).run();
    await session.handle(JSON.stringify({ t: "ping" }));
    expect(link.sent).toEqual([{ t: "pong" }]);
    expect(deps.db.select().from(schema.runners).get()!.lastSeenAt).toBeGreaterThan(1);
  });

  test("job.events: persists, projects, broadcasts once, and acks the max seq; replays are deduped", async () => {
    const { deps, link, session } = setup();
    const runId = addRun(deps, { status: "assigned", runnerId: "r1" });
    const seen: RunEvent[] = [];
    deps.hub.subscribe(runId, (e) => seen.push(e));

    const batch1: RunEvent[] = [
      ev(runId, 1, "run.status", { status: "running", workspace: { path: "/wt", branch: "orch/x" } }, undefined, 1000),
      ev(runId, 2, "step.started", {}, "impl", 1001),
      ev(runId, 3, "acp.update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } }, "impl"),
      ev(runId, 4, "finding", { file: "src/a.ts", line: 3, severity: "warning", message: "hmm" }, "impl"),
      ev(runId, 5, "step.finished", { status: "succeeded", output: "hi", structured: { ok: 1 } }, "impl", 1005),
    ];
    await session.handle(JSON.stringify({ t: "job.events", runId, events: batch1 }));
    // Reconnect replay: overlapping batch with one new event, out of order.
    const batch2 = [ev(runId, 6, "step.started", {}, "msg", 1006), batch1[3]!, batch1[4]!];
    await session.handle(JSON.stringify({ t: "job.events", runId, events: batch2 }));

    expect(link.of("job.ack")).toEqual([
      { t: "job.ack", runId, seq: 5 },
      { t: "job.ack", runId, seq: 6 },
    ]);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(eventsAfter(deps, runId, 0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(eventsAfter(deps, runId, 4).map((e) => e.type)).toEqual(["step.finished", "step.started"]);

    const run = deps.runs.get(runId)!;
    expect(run).toMatchObject({
      status: "running",
      startedAt: 1000,
      finishedAt: null,
      workspace: { path: "/wt", branch: "orch/x" },
    });
    const steps = deps.db.select().from(schema.runSteps).where(eq(schema.runSteps.runId, runId)).all();
    const byId = Object.fromEntries(steps.map((s) => [s.stepId, s]));
    expect(byId.impl).toMatchObject({ idx: 0, status: "succeeded", output: "hi", structured: { ok: 1 }, startedAt: 1001, finishedAt: 1005 });
    expect(byId.msg).toMatchObject({ idx: 1, status: "running", startedAt: 1006 });
    expect(byId.commit).toMatchObject({ idx: 2, status: "pending" });
    const fs = deps.db.select().from(schema.findings).all();
    expect(fs).toHaveLength(1); // the replayed finding was not inserted twice
    expect(fs[0]).toMatchObject({ runId, stepId: "impl", file: "src/a.ts", line: 3, severity: "warning", endLine: null });
  });

  test("terminal run.status sets finished_at/error; later non-terminal status cannot resurrect the run", async () => {
    const { deps, session } = setup();
    const runId = addRun(deps, { status: "running", runnerId: "r1" });
    await session.handle(
      JSON.stringify({
        t: "job.events",
        runId,
        events: [
          ev(runId, 1, "step.started", {}, "impl", 10),
          ev(runId, 2, "run.status", { status: "failed", error: "boom" }, undefined, 20),
          ev(runId, 3, "run.status", { status: "running" }, undefined, 30),
        ],
      }),
    );
    expect(deps.runs.get(runId)).toMatchObject({ status: "failed", error: "boom", finishedAt: 20 });
    const step = deps.db.select().from(schema.runSteps).where(eq(schema.runSteps.stepId, "impl")).get()!;
    expect(step).toMatchObject({ status: "failed", finishedAt: 20 });
  });

  test("events for a run held by another runner are acked but neither stored nor projected", async () => {
    const { deps, link, session } = setup();
    const runId = addRun(deps, { status: "running", runnerId: "r2" });
    await session.handle(
      JSON.stringify({ t: "job.events", runId, events: [ev(runId, 1, "run.status", { status: "failed", error: "x" })] }),
    );
    expect(link.of("job.ack")).toEqual([{ t: "job.ack", runId, seq: 1 }]);
    expect(eventsAfter(deps, runId, 0)).toEqual([]);
    expect(deps.runs.get(runId)!.status).toBe("running");
  });

  test("workspace from run.status(running) persists and survives later non-terminal statuses", async () => {
    const { deps, session } = setup();
    const runId = addRun(deps, { status: "assigned", runnerId: "r1" });
    await session.handle(
      JSON.stringify({
        t: "job.events",
        runId,
        events: [
          ev(runId, 1, "run.status", { status: "running", workspace: { path: "/wt", branch: "orch/x", repo: "acme/widget" } }, undefined, 10),
          ev(runId, 2, "run.status", { status: "running" }, undefined, 20),
        ],
      }),
    );
    expect(deps.runs.get(runId)).toMatchObject({
      status: "running",
      workspace: { path: "/wt", branch: "orch/x", repo: "acme/widget" },
    });
  });

  test("job.finished makes the run terminal and frees capacity for queued runs", async () => {
    const { deps, link, session } = setup();
    await session.handle(JSON.stringify({ ...hello, capabilities: caps({ maxConcurrentJobs: 1 }) }));
    const first = addRun(deps, { status: "running", runnerId: "r1", createdAt: 1 });
    const second = addRun(deps, { createdAt: 2 });
    deps.scheduler.kick();
    expect(deps.runs.get(second)!.status).toBe("queued");

    await session.handle(JSON.stringify({ t: "job.finished", runId: first, status: "succeeded" }));
    expect(deps.runs.get(first)).toMatchObject({ status: "succeeded" });
    expect(deps.runs.get(first)!.finishedAt).not.toBeNull();
    expect(deps.runs.get(second)).toMatchObject({ status: "assigned", runnerId: "r1" });
    expect(link.of("job.assign").map((m) => m.run.runId)).toEqual([second]);

    // The runner's own final run.status arriving after job.finished is stored but changes nothing.
    await session.handle(JSON.stringify({ t: "job.events", runId: first, events: [ev(first, 1, "run.status", { status: "succeeded" })] }));
    expect(deps.runs.get(first)!.status).toBe("succeeded");
    expect(eventsAfter(deps, first, 0)).toHaveLength(1);
  });

  test("job.rejected fails the run with the reason and records a run.status event", async () => {
    const { deps, session } = setup();
    const runId = addRun(deps, { status: "assigned", runnerId: "r1" });
    const seen: RunEvent[] = [];
    deps.hub.subscribe(runId, (e) => seen.push(e));
    await session.handle(JSON.stringify({ t: "job.rejected", runId, reason: "Unknown harness: x" }));
    expect(deps.runs.get(runId)).toMatchObject({ status: "failed", error: "Unknown harness: x" });
    expect(seen).toMatchObject([{ seq: 1, type: "run.status", payload: { status: "failed", error: "Unknown harness: x" } }]);
  });

  test("rpc.result resolves a pending server RPC only for the runner it was sent to", async () => {
    const { deps, link, session } = setup();
    await session.handle(JSON.stringify(hello));
    const pending = deps.hub.rpc<{ path: string }>("r1", "fs.list", { path: "/x" }, 1000);
    const call = link.of("rpc.call")[0]!;
    expect(call).toMatchObject({ method: "fs.list", params: { path: "/x" } });
    const other = new RunnerSession(deps, "r2", new FakeLink());
    await other.handle(JSON.stringify({ t: "rpc.result", rpcId: call.rpcId, ok: true, result: { path: "evil" } }));
    await session.handle(JSON.stringify({ t: "rpc.result", rpcId: call.rpcId, ok: true, result: { path: "/x" } }));
    expect(await pending).toEqual({ path: "/x" });
  });

  test("invalid frames are dropped without a reply", async () => {
    const { link, session } = setup();
    await session.handle("not json");
    await session.handle(JSON.stringify({ t: "job.events", runId: "x", events: [{ seq: 0 }] }));
    expect(link.sent).toEqual([]);
  });
});

describe("server restart", () => {
  test("assigned/running runs survive a restart and the reconnecting runner resumes from lastAckedSeq", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-restart-"));
    try {
      const config = parseServerConfig({ dataDir: dir }, "/");
      const before = createDeps(config, { webDist: "/nonexistent" });
      addRunner(before, "r1", { capabilities: caps() });
      const running = addRun(before, { status: "running", runnerId: "r1" });
      const assigned = addRun(before, { status: "assigned", runnerId: "r1" });
      before.runs.ingest(running, [ev(running, 1, "run.status", { status: "running" }), ev(running, 2, "step.started", {}, "impl")]);
      before.db.$client.close();

      const after = createDeps(config, { webDist: "/nonexistent" });
      after.scheduler.kick();
      expect(after.runs.get(running)!.status).toBe("running");
      expect(after.runs.get(assigned)!.status).toBe("assigned");
      const link = new FakeLink();
      const session = new RunnerSession(after, "r1", link);
      await session.handle(JSON.stringify(hello));
      expect(link.of("welcome")).toEqual([{ t: "welcome", lastAckedSeq: { [running]: 2, [assigned]: 0 } }]);
      // The runner replays from its outbox; already-stored events are deduped, new ones appended contiguously.
      await session.handle(
        JSON.stringify({ t: "job.events", runId: running, events: [ev(running, 2, "step.started", {}, "impl"), ev(running, 3, "sandbox.log", { stream: "stdout", text: "x" })] }),
      );
      expect(eventsAfter(after, running, 0).map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(link.of("job.assign")).toEqual([]); // nothing is re-assigned
      after.db.$client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function ev(runId: string, seq: number, type: RunEvent["type"], payload: unknown, stepId?: string, ts = Date.now()): RunEvent {
  return { runId, seq, ts, type, payload, ...(stepId ? { stepId } : {}) } as RunEvent;
}
