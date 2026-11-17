import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@orch/protocol";
import { applyRunEvents, initialRunViewState } from "../src/runState";

let seq = 0;
const ev = (e: Omit<RunEvent, "seq" | "runId" | "ts">): RunEvent =>
  ({ runId: "r1", ts: 0, seq: ++seq, ...e }) as RunEvent;
const chunk = (sessionUpdate: string, text: string) =>
  ev({ type: "acp.update", stepId: "a", payload: { update: { sessionUpdate, content: { type: "text", text } } } });

describe("applyRunEvents", () => {
  test("coalesces chunks, merges tool calls, replaces plans, tracks subagents and dialogs", () => {
    seq = 0;
    const events: RunEvent[] = [
      ev({ type: "run.status", payload: { status: "running", workspace: { path: "/w", branch: "orch/x", repo: "acme/widget" } } }),
      ev({ type: "step.started", stepId: "a", payload: {} }),
      chunk("agent_thought_chunk", "hmm "),
      chunk("agent_thought_chunk", "ok"),
      chunk("agent_message_chunk", "Hel"),
      chunk("agent_message_chunk", "lo"),
      ev({
        type: "acp.update",
        stepId: "a",
        payload: { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "task", status: "pending" } },
      }),
      ev({
        type: "acp.update",
        stepId: "a",
        payload: { update: { sessionUpdate: "plan", entries: [{ content: "x", priority: "high", status: "pending" }] } },
      }),
      ev({
        type: "acp.update",
        stepId: "a",
        payload: { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } },
      }),
      ev({
        type: "acp.update",
        stepId: "a",
        payload: { update: { sessionUpdate: "plan", entries: [{ content: "x", priority: "high", status: "completed" }] } },
      }),
      chunk("agent_message_chunk", "Done"),
      ev({ type: "subagent.started", stepId: "a", payload: { agentId: "S1", agent: "scout", task: "t", model: null } }),
      ev({
        type: "subagent.message",
        stepId: "a",
        payload: { agentId: "S1", role: "assistant", blocks: [{ type: "text", text: "hi" }] },
      }),
      ev({ type: "acp.permission_request", stepId: "a", payload: { requestId: "p1", toolCall: {}, options: [] } }),
      ev({ type: "acp.permission_resolved", stepId: "a", payload: { requestId: "p1", optionId: null } }),
      ev({ type: "intervention.request", stepId: "gate", payload: { requestId: "i1", message: "review it", sessions: [] } }),
      ev({ type: "intervention.resolved", stepId: "gate", payload: { requestId: "i1", action: "continue" } }),
      ev({ type: "step.finished", stepId: "a", payload: { status: "succeeded", output: "HelloDone" } }),
    ];
    const s = applyRunEvents(initialRunViewState, events);
    const step = s.steps.a!;
    expect(s.workspace).toEqual({ path: "/w", branch: "orch/x", repo: "acme/widget" });
    expect(step.status).toBe("succeeded");
    expect(step.items.map((i) => i.kind)).toEqual(["thought", "assistant", "tool", "plan", "assistant"]);
    expect(step.items[0]).toEqual({ kind: "thought", text: "hmm ok" });
    expect(step.items[1]).toEqual({ kind: "assistant", text: "Hello" });
    expect(step.items[3]).toMatchObject({ entries: [{ status: "completed" }] });
    expect(step.toolCalls.t1).toMatchObject({ title: "task", status: "completed" });
    expect(step.subagents).toHaveLength(1);
    expect(step.subagents[0]!.messages).toHaveLength(1);
    expect(s.permissions[0]!.resolved).toBe(true);
    expect(s.interventions[0]).toMatchObject({ requestId: "i1", stepId: "gate", message: "review it", resolved: true });
    // Replayed events (seq <= lastSeq) are ignored.
    expect(applyRunEvents(s, events)).toBe(s);
  });

  test("a non-terminal run.status clears a stale error; a terminal one keeps it", () => {
    seq = 0;
    const failed = applyRunEvents(initialRunViewState, [
      ev({ type: "run.status", payload: { status: "running" } }),
      ev({ type: "run.status", payload: { status: "failed", error: "step blew up" } }),
    ]);
    expect(failed.error).toBe("step blew up");
    // Retry: the run re-enters queued; the previous attempt's banner must not stick around.
    expect(applyRunEvents(failed, [ev({ type: "run.status", payload: { status: "queued" } })]).error).toBeUndefined();
    expect(applyRunEvents(failed, [ev({ type: "run.status", payload: { status: "running" } })]).error).toBeUndefined();
    // A terminal status with its own error replaces it; without one it keeps the sticky error.
    expect(applyRunEvents(failed, [ev({ type: "run.status", payload: { status: "cancelled" } })]).error).toBe("step blew up");
    expect(applyRunEvents(failed, [ev({ type: "run.status", payload: { status: "failed", error: "again" } })]).error).toBe("again");
  });

  test("retry resets the resume step and later steps; a restarted step drops its previous result", () => {
    seq = 0;
    const done = (stepId: string, status: "succeeded" | "failed") =>
      ev({ type: "step.finished", stepId, payload: { status, output: `${stepId} out`, structured: { stepId }, error: status === "failed" ? "boom" : undefined } });
    const failed = applyRunEvents(initialRunViewState, [
      ev({ type: "step.started", stepId: "a", payload: {} }),
      done("a", "succeeded"),
      ev({ type: "step.started", stepId: "b", payload: {} }),
      chunk("agent_message_chunk", "x"),
      done("b", "succeeded"),
      ev({ type: "step.started", stepId: "c", payload: {} }),
      done("c", "failed"),
      ev({ type: "run.status", payload: { status: "failed", error: "boom" } }),
    ]);
    expect(failed.stepOrder).toEqual(["a", "b", "c"]);

    const retried = applyRunEvents(failed, [ev({ type: "run.status", payload: { status: "queued", resumeFromStepId: "b" } })]);
    expect(retried.error).toBeUndefined();
    expect(retried.steps.a).toEqual(failed.steps.a!);
    for (const id of ["b", "c"]) {
      expect(retried.steps[id]).toMatchObject({ status: "pending", output: undefined, structured: undefined, error: undefined });
    }
    // The transcript survives the reset.
    expect(retried.steps.b!.items).toEqual(failed.steps.b!.items);

    const restarted = applyRunEvents(failed, [ev({ type: "step.started", stepId: "c", payload: {} })]);
    expect(restarted.steps.c).toMatchObject({ status: "running", output: undefined, structured: undefined, error: undefined });
  });
});

describe("run.name", () => {
  test("the first run.name event wins, matching the server's first-write-wins", () => {
    seq = 0;
    const state = applyRunEvents(initialRunViewState, [ev({ type: "run.name", payload: { name: "Boot fix" } })]);
    expect(state.name).toBe("Boot fix");
    const again = applyRunEvents(state, [ev({ type: "run.name", payload: { name: "Better name" } })]);
    expect(again.name).toBe("Boot fix");
  });
});

describe("loops", () => {
  const chunkOf = (stepId: string, sessionUpdate: string, text: string) =>
    ev({ type: "acp.update", stepId, payload: { update: { sessionUpdate, content: { type: "text", text } } } });
  const bodyDone = (stepId: string, status: "succeeded" | "skipped" | "failed" = "succeeded") =>
    ev({ type: "step.finished", stepId, payload: { status, output: `${stepId} out` } });
  const firstPass = (loopStepId: string, body: string[]): RunEvent[] => [
    ...body.flatMap((id) => [
      ev({ type: "step.started", stepId: id, payload: {} }),
      chunkOf(id, "agent_message_chunk", `${id} out`),
      bodyDone(id),
    ]),
    ev({ type: "step.started", stepId: loopStepId, payload: {} }),
    ev({ type: "step.finished", stepId: loopStepId, payload: { status: "succeeded", output: `Repeating from fix (iteration 2 of 3)` } }),
    ev({
      type: "loop.repeat",
      stepId: loopStepId,
      payload: { toStepId: body[0]!, iteration: 2, maxIterations: 3, stepIds: body },
    }),
  ];

  test("loop.repeat resets the listed steps to pending, keeps their transcripts and records the counter", () => {
    seq = 0;
    const afterFirst = applyRunEvents(initialRunViewState, firstPass("loop1", ["fix", "test"]));
    expect(afterFirst.loops.loop1).toEqual({ iteration: 2, maxIterations: 3 });
    expect(afterFirst.steps.fix).toMatchObject({ status: "pending", output: undefined });
    expect(afterFirst.steps.test).toMatchObject({ status: "pending", output: undefined });
    // Transcripts survive the reset: the next pass appends to them.
    expect(afterFirst.steps.fix!.items).toHaveLength(1);
    expect(afterFirst.steps.fix!.items[0]).toEqual({ kind: "assistant", text: "fix out" });

    // Second pass: dividers mark the new iteration; the loop counter updates.
    const second = applyRunEvents(afterFirst, [
      ev({ type: "step.started", stepId: "fix", payload: { iteration: 2 } }),
      chunkOf("fix", "agent_message_chunk", "pass two"),
      ev({ type: "step.started", stepId: "test", payload: { iteration: 2 } }),
    ]);
    expect(second.loops.loop1).toEqual({ iteration: 2, maxIterations: 3 });
    expect(second.steps.fix!.items).toEqual([
      { kind: "assistant", text: "fix out" },
      { kind: "iteration", n: 2 },
      { kind: "assistant", text: "pass two" },
    ]);
    expect(second.steps.test!.items).toEqual([{ kind: "assistant", text: "test out" }, { kind: "iteration", n: 2 }]);
  });

  test("re-applying loop events (seq <= lastSeq) changes nothing", () => {
    seq = 0;
    const events = firstPass("loop1", ["fix", "test"]);
    const s = applyRunEvents(initialRunViewState, events);
    expect(applyRunEvents(s, events)).toBe(s);
    expect(s.loops.loop1).toEqual({ iteration: 2, maxIterations: 3 });
    expect(s.steps.fix!.items).toEqual([{ kind: "assistant", text: "fix out" }]);
  });

  test("a retry (queued with resumeFromStepId) clears loop counters at or after the cursor", () => {
    seq = 0;
    const afterFirst = applyRunEvents(initialRunViewState, [
      ...firstPass("outer", ["fix", "test", "gate"]),
      // An inner loop inside the outer body repeated too.
      ev({
        type: "loop.repeat",
        stepId: "inner",
        payload: { toStepId: "fix", iteration: 2, maxIterations: 5, stepIds: ["fix"] },
      }),
    ]);
    expect(afterFirst.loops).toEqual({ outer: { iteration: 2, maxIterations: 3 }, inner: { iteration: 2, maxIterations: 5 } });
    // Retry from the outer body: both counters restart (the runner restarts them as well).
    const retried = applyRunEvents(afterFirst, [ev({ type: "run.status", payload: { status: "queued", resumeFromStepId: "fix" } })]);
    expect(retried.loops).toEqual({});
    expect(retried.steps.fix).toMatchObject({ status: "pending" });
  });

  test("an outer loop.repeat drops the counters of loops nested in its body", () => {
    seq = 0;
    const innerRepeat = ev({ type: "loop.repeat", stepId: "inner", payload: { toStepId: "fix", iteration: 3, maxIterations: 3, stepIds: ["fix"] } });
    const s = applyRunEvents(initialRunViewState, [innerRepeat, ...firstPass("outer", ["plan", "fix", "inner"])]);
    // The runner restarts the inner loop at pass 1, so a kept `3/3` badge would be stale.
    expect(s.loops).toEqual({ outer: { iteration: 2, maxIterations: 3 } });
  });

  test("a skipped finish records status skipped and counts as done for retry cursors", () => {
    seq = 0;
    const s = applyRunEvents(initialRunViewState, [
      ev({ type: "step.started", stepId: "a", payload: {} }),
      bodyDone("a"),
      // A `value` stop fired on `a`: the rest of the iteration is bypassed without ever starting.
      bodyDone("b", "skipped"),
      bodyDone("c", "skipped"),
    ]);
    expect(s.steps.b).toMatchObject({ status: "skipped", output: "b out" });
    expect(s.steps.c!.status).toBe("skipped");
  });
});
