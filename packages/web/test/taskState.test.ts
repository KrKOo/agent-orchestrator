import type { RunEvent, RunRow, TaskMessage, TaskRow } from "@orch/protocol";
import { describe, expect, test } from "bun:test";
import { applyTaskItem, applyTaskItems, childRuns, initialTaskState, managerTail } from "../src/taskState";

let messageSeq = 0;
const message = (over: Partial<TaskMessage> = {}): TaskMessage => {
  const seq = over.seq ?? ++messageSeq;
  messageSeq = Math.max(messageSeq, seq);
  return { taskId: "t1", seq, role: "user", text: `m${seq}`, ts: 0, ...over };
};

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1",
  title: "Fix the flaky test",
  status: "active",
  createdBy: "octocat",
  settings: {
    repos: [{ github: "acme/widget", localPath: "/repos/widget" }],
    interventions: "manager",
    merge: "auto",
    autoMergeFinal: false,
    managerModels: { model: "anthropic/claude-sonnet-4-5" },
    allowNetworkModes: ["gateway_only", "allowlist"],
    maxParallelRuns: 3,
  },
  integration: {},
  managerRunId: null,
  inboxAckedSeq: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: "r1",
  flowId: "builtin:manager",
  flowName: "Manager",
  flowVersion: 1,
  definition: {
    name: "Manager",
    inputs: [],
    workspace: { kind: "local_path", path: "/repos/widget", isolation: "direct", baseRef: "HEAD", access: "ro" },
    sandbox: { provider: "docker", image: "orch/sandbox-omp:latest", network: { mode: "gateway_only", allow: [] }, cpus: 2, memoryMb: 4096 },
    harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
    approval: "auto",
    runnerLabels: [],
    trigger: { kind: "manual" },
    steps: [{ id: "manager", kind: "prompt", name: "Manager", prompt: "manage", freshSession: false, timeoutSec: 0 }],
  },
  inputs: {},
  status: "running",
  trust: "owner",
  runnerId: "runner1",
  createdBy: "octocat",
  triggerKind: "manual",
  name: null,
  autoName: false,
  github: null,
  error: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
  workspace: null,
  taskId: "t1",
  role: "manager",
  interventionHandler: null,
  ...over,
});

let eventSeq = 0;
const chunkEvent = (text: string): RunEvent => ({
  runId: "r1",
  ts: 0,
  seq: ++eventSeq,
  stepId: "manager",
  type: "acp.update",
  payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
});

describe("taskState", () => {
  test("backlog items fold into messages, the task row and its runs", () => {
    messageSeq = 0;
    eventSeq = 0;
    const state = applyTaskItems(initialTaskState, [
      { t: "task", task: task({ managerRunId: "r1" }) },
      { t: "message", message: message() },
      { t: "message", message: message({ seq: 2, role: "manager", text: "hello" }) },
      { t: "run", run: run() },
      { t: "run", run: run({ id: "r2", role: "worker", interventionHandler: "manager", flowId: "f1" }) },
    ]);
    expect(state.messages.map((m) => m.text)).toEqual(["m1", "hello"]);
    expect(state.task?.managerRunId).toBe("r1");
    expect(Object.keys(state.runs)).toEqual(["r1", "r2"]);
    expect(state.lastSeq).toBe(2);
  });

  test("messages dedupe by seq and arrive out of order stay ascending", () => {
    messageSeq = 0;
    const late = message({ seq: 2, text: "late" });
    const first = applyTaskItems(initialTaskState, [{ t: "message", message: message({ seq: 1 }) }, { t: "message", message: late }]);
    expect(first.messages.map((m) => m.seq)).toEqual([1, 2]);
    // Replayed backlog: both known seqs are no-ops.
    expect(applyTaskItems(first, [{ t: "message", message: message({ seq: 1 }) }, { t: "message", message: late }])).toBe(first);
    // Out of order: seq 5 folds after the rest (which arrive later), staying sorted.
    const five = applyTaskItem(first, { t: "message", message: message({ seq: 5, text: "five" }) });
    const withGap = applyTaskItems(five, [
      { t: "message", message: message({ seq: 3, text: "three" }) },
      { t: "message", message: message({ seq: 4, text: "four" }) },
    ]);
    expect(withGap.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(withGap.messages.map((m) => m.text)).toEqual(["m1", "late", "three", "four", "five"]);
  });

  test("runs upsert by id, keeping the newest row", () => {
    messageSeq = 0;
    let state = applyTaskItems(initialTaskState, [{ t: "run", run: run({ status: "queued" }) }]);
    expect(state.runs.r1?.status).toBe("queued");
    state = applyTaskItems(state, [{ t: "run", run: run({ status: "running" }) }]);
    expect(Object.keys(state.runs)).toEqual(["r1"]);
    expect(state.runs.r1?.status).toBe("running");
  });

  test("the task row replaces wholesale", () => {
    messageSeq = 0;
    let state = applyTaskItems(initialTaskState, [
      { t: "task", task: task({ status: "active", updatedAt: 1 }) },
      { t: "task", task: task({ status: "needs_input", updatedAt: 2 }) },
    ]);
    expect(state.task).toEqual(task({ status: "needs_input", updatedAt: 2 }));
    state = applyTaskItems(state, [{ t: "task", task: task({ id: "other" }) }]);
    expect(state.task?.id).toBe("other");
  });

  test("the manager transcript keeps only the current managerRunId's events and resets when it changes", () => {
    messageSeq = 0;
    eventSeq = 0;
    // The task row sets the manager run; the transcript keys off the task's managerRunId.
    let state = applyTaskItems(initialTaskState, [{ t: "task", task: task({ managerRunId: "r1" }) }]);
    const ev = chunkEvent("hello ");
    state = applyTaskItems(state, [{ t: "manager", event: ev }]);
    expect(state.managerTranscript).toEqual({ runId: "r1", items: [ev] });
    // A different manager run resets the transcript and re-keys it.
    state = applyTaskItems(state, [{ t: "task", task: task({ managerRunId: "r9" }) }]);
    expect(state.managerTranscript).toEqual({ runId: "r9", items: [] });
    // Events of the old run no longer fold.
    state = applyTaskItems(state, [{ t: "manager", event: chunkEvent("stale") }]);
    expect(state.managerTranscript?.items).toEqual([]);
    // Neither do events of an unrelated run when no task row has been seen yet.
    const orphan = applyTaskItem(initialTaskState, { t: "manager", event: chunkEvent("no run yet") });
    expect(orphan.managerTranscript).toBeNull();
    expect(orphan.task).toBeNull();
  });

  test("manager events of the current run fold in order", () => {
    messageSeq = 0;
    eventSeq = 0;
    let state = applyTaskItems(initialTaskState, [{ t: "task", task: task({ managerRunId: "r1" }) }]);
    state = applyTaskItems(state, [
      { t: "manager", event: chunkEvent("a") },
      { t: "manager", event: chunkEvent("b") },
    ]);
    expect(state.managerTranscript?.items).toHaveLength(2);
    expect(managerTail(state)).toBe("ab");
  });

  test("childRuns lists worker runs newest first and excludes the manager run", () => {
    messageSeq = 0;
    const state = applyTaskItems(initialTaskState, [
      { t: "run", run: run({ id: "mgr", role: "manager" }) },
      { t: "run", run: run({ id: "older", role: "worker", createdAt: 1 }) },
      { t: "run", run: run({ id: "newer", role: "worker", createdAt: 2 }) },
      { t: "run", run: run({ id: "plain", taskId: null, role: null, createdAt: 3 }) },
    ]);
    expect(childRuns(state).map((r) => r.id)).toEqual(["newer", "older"]);
  });
});
