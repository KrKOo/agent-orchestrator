import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@orch/protocol";
import { pendingRequest } from "../src/runRequests";
import { applyRunEvents, groupToolRuns, initialRunViewState, linkSubagents, modelsSwitchText, type StepView, type ToolCallView, type TranscriptItem } from "../src/runState";

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
    expect(step.subagents[0]!.items).toEqual([{ kind: "assistant", text: "hi" }]);
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

  test("a terminal status settles requests left open, so a retry's new request is the pending one", () => {
    seq = 0;
    const lost = applyRunEvents(initialRunViewState, [
      ev({ type: "acp.permission_request", stepId: "a", payload: { requestId: "p1", toolCall: {}, options: [] } }),
      ev({ type: "intervention.request", stepId: "gate", payload: { requestId: "i1", message: "review it", sessions: [] } }),
      // runner_lost: the server terminates the run with run.status only, no *_resolved events.
      ev({ type: "run.status", payload: { status: "failed", error: "runner lost" } }),
    ]);
    expect(lost.permissions.map((p) => p.resolved)).toEqual([true]);
    expect(lost.interventions.map((i) => i.resolved)).toEqual([true]);
    expect(pendingRequest(lost, new Set())).toBeUndefined();

    const retried = applyRunEvents(lost, [
      ev({ type: "run.status", payload: { status: "queued", resumeFromStepId: "gate" } }),
      ev({ type: "intervention.request", stepId: "gate", payload: { requestId: "i2", message: "review it", sessions: [] } }),
    ]);
    expect(pendingRequest(retried, new Set())).toMatchObject({ kind: "intervention", request: { requestId: "i2" } });
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

describe("run.models", () => {
  test("a switch is a marker in its step's transcript, between that step's updates; replays fold once", () => {
    seq = 0;
    const models = { model: "x/opus", modelRoles: { task: "x/haiku" } };
    const events = [
      chunk("agent_message_chunk", "before"),
      ev({ type: "run.models", stepId: "a", payload: { models, applied: "restart" } }),
      chunk("agent_message_chunk", "after"),
    ];
    const state = applyRunEvents(initialRunViewState, events);
    expect(state.steps.a!.items).toEqual([
      { kind: "assistant", text: "before" },
      { kind: "models", models, applied: "restart" },
      { kind: "assistant", text: "after" },
    ]);
    expect(applyRunEvents(state, events)).toBe(state);
    expect(modelsSwitchText(models, "restart")).toBe(
      "Models switched: default → x/opus, smol → x/opus, task → x/haiku; applies from the next agent turn",
    );
    expect(modelsSwitchText({ model: "x/a", smolModel: "x/b" }, "live")).toBe("Models switched: default → x/a, smol → x/b");
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

describe("intervention choices", () => {
  test("a resolved gate keeps the picked choice; replay changes nothing", () => {
    seq = 0;
    const events: RunEvent[] = [
      ev({
        type: "intervention.request",
        stepId: "gate",
        payload: {
          requestId: "i1",
          message: "review it",
          sessions: [],
          choices: [
            { id: "approve", label: "Approve" },
            { id: "fix", label: "Fix" },
          ],
        },
      }),
      ev({ type: "intervention.resolved", stepId: "gate", payload: { requestId: "i1", action: "continue", choice: "fix" } }),
    ];
    const s = applyRunEvents(initialRunViewState, events);
    expect(s.interventions[0]).toMatchObject({
      requestId: "i1",
      stepId: "gate",
      resolved: true,
      choice: "fix",
      choices: [
        { id: "approve", label: "Approve" },
        { id: "fix", label: "Fix" },
      ],
    });
    // Replayed events (seq <= lastSeq) are ignored.
    expect(applyRunEvents(s, events)).toBe(s);
  });

  test("a resolve without a choice (plain continue or cancel) leaves choice unset", () => {
    seq = 0;
    const s = applyRunEvents(initialRunViewState, [
      ev({ type: "intervention.request", stepId: "gate", payload: { requestId: "i2", message: "m", sessions: [] } }),
      ev({ type: "intervention.resolved", stepId: "gate", payload: { requestId: "i2", action: "cancel" } }),
    ]);
    expect(s.interventions[0]!.choice).toBeUndefined();
    expect(s.interventions[0]!.resolved).toBe(true);
  });
});

describe("subagents", () => {
  const started = (agentId: string) =>
    ev({ type: "subagent.started", stepId: "a", payload: { agentId, agent: "task", task: `do ${agentId}`, model: null } });
  type Blocks = Extract<RunEvent, { type: "subagent.message" }>["payload"]["blocks"];
  const message = (agentId: string, role: "user" | "assistant" | "toolResult", blocks: Blocks) =>
    ev({ type: "subagent.message", stepId: "a", payload: { agentId, role, blocks } });
  /** A main-thread `task` call; `undefined` stands for an unnamed task. */
  const taskCall = (toolCallId: string, names: (string | undefined)[]) =>
    ev({
      type: "acp.update",
      stepId: "a",
      payload: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          name: "task",
          title: "task",
          status: "in_progress",
          rawInput: { tasks: names.map((name) => (name === undefined ? { task: "t" } : { name, task: "t" })) },
        },
      },
    });
  const finished = (toolCallId: string) =>
    ev({ type: "acp.update", stepId: "a", payload: { update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" } } });
  const stepOf = (events: RunEvent[]): StepView => applyRunEvents(initialRunViewState, events).steps.a!;
  const linked = (step: StepView) => {
    const links = linkSubagents(step);
    return {
      byToolCall: Object.fromEntries([...links.byToolCall].map(([id, agents]) => [id, agents.map((a) => a.agentId)])),
      unlinked: links.unlinked.map((a) => a.agentId),
    };
  };

  test("pairs results with calls by toolCallId, isError fails the call, consecutive text merges", () => {
    seq = 0;
    const step = stepOf([
      started("S1"),
      message("S1", "user", [{ type: "text", text: "Find it" }]),
      message("S1", "assistant", [
        { type: "thinking", text: "plan" },
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "toolCall", id: "c1", name: "read", intent: "Reading x", arguments: { path: "x" } },
        { type: "toolCall", id: "c2", name: "grep", arguments: { pattern: "y" } },
      ]),
      message("S1", "toolResult", [{ type: "toolResult", text: "no such file", toolCallId: "c2", isError: true }]),
      message("S1", "toolResult", [
        { type: "toolResult", text: "p1", toolCallId: "c1", isError: false },
        { type: "toolResult", text: "p2", toolCallId: "c1", isError: false },
      ]),
    ]);
    const agent = step.subagents[0]!;
    expect(agent.items).toEqual([
      { kind: "user", text: "Find it" },
      { kind: "thought", text: "plan" },
      { kind: "assistant", text: "a\n\nb" },
      { kind: "tool", toolCallId: "c1" },
      { kind: "tool", toolCallId: "c2" },
    ]);
    expect(agent.toolCalls.c1).toMatchObject({
      title: "Reading x",
      name: "read",
      status: "completed",
      rawInput: { path: "x" },
      content: [{ type: "content", content: { type: "text", text: "p1\np2" } }],
    });
    expect(agent.toolCalls.c2).toMatchObject({ title: "grep", status: "failed" });
  });

  test("results stored without a call id answer the oldest unanswered call", () => {
    seq = 0;
    const step = stepOf([
      started("S1"),
      message("S1", "assistant", [
        { type: "toolCall", id: "c1", name: "read", arguments: {} },
        { type: "toolCall", id: "c2", name: "read", arguments: {} },
        { type: "toolCall", id: "c3", name: "read", arguments: {} },
      ]),
      message("S1", "toolResult", [{ type: "toolResult", text: "r1" }]),
      // An empty result, stored as no blocks before the tail sent a placeholder.
      message("S1", "toolResult", []),
      message("S1", "toolResult", [{ type: "toolResult", text: "r3" }]),
    ]);
    const calls = step.subagents[0]!.toolCalls;
    expect(calls.c1).toMatchObject({ status: "completed", content: [{ content: { text: "r1" } }] });
    expect(calls.c2).toMatchObject({ status: "completed", content: [] });
    expect(calls.c3).toMatchObject({ status: "completed", content: [{ content: { text: "r3" } }] });
  });

  test("links agents to task calls by name, exactly before case-insensitively, across calls", () => {
    seq = 0;
    const step = stepOf([
      taskCall("t1", ["Alpha", "Beta"]),
      started("Alpha"),
      started("Beta"),
      finished("t1"),
      taskCall("t2", ["gamma"]),
      started("Gamma"),
    ]);
    expect(linked(step)).toEqual({ byToolCall: { t1: ["Alpha", "Beta"], t2: ["Gamma"] }, unlinked: [] });
  });

  test("a name asked for again in a later call goes to the first agent no earlier call claimed", () => {
    seq = 0;
    const step = stepOf([taskCall("t1", ["Scout"]), started("Scout"), finished("t1"), taskCall("t2", ["Scout"]), started("scout")]);
    expect(linked(step)).toEqual({ byToolCall: { t1: ["Scout"], t2: ["scout"] }, unlinked: [] });
  });

  test("an unnamed task links through the one running call; otherwise the agent is unlinked", () => {
    seq = 0;
    expect(linked(stepOf([taskCall("t1", [undefined]), started("Gen-1")]))).toEqual({ byToolCall: { t1: ["Gen-1"] }, unlinked: [] });
    seq = 0;
    expect(linked(stepOf([taskCall("t1", [undefined]), taskCall("t2", [undefined]), started("Gen-1")]))).toEqual({
      byToolCall: {},
      unlinked: ["Gen-1"],
    });
    seq = 0;
    expect(linked(stepOf([started("Stray")]))).toEqual({ byToolCall: {}, unlinked: ["Stray"] });
  });

  test("nested agents link through their parent agent's own task calls, unnamed ones despite the outer call running", () => {
    seq = 0;
    const step = stepOf([
      taskCall("t1", ["Outer"]),
      started("Outer"),
      message("Outer", "assistant", [{ type: "toolCall", id: "n1", name: "task", arguments: { tasks: [{ name: "Inner", task: "t" }] } }]),
      started("Inner"),
      message("Outer", "toolResult", [{ type: "toolResult", text: "", toolCallId: "n1" }]),
      // t1 stays running while Outer runs: Gen-2 starts with both t1 and n2 open.
      message("Outer", "assistant", [{ type: "toolCall", id: "n2", name: "task", arguments: { tasks: [{ task: "t" }] } }]),
      started("Gen-2"),
    ]);
    expect(step.subagents.find((a) => a.agentId === "Gen-2")!.openTaskCalls).toEqual(["t1", "n2"]);
    expect(linked(step)).toEqual({ byToolCall: { t1: ["Outer"], n1: ["Inner"], n2: ["Gen-2"] }, unlinked: [] });
    expect(linkSubagents(step).parentCall.get("Inner")?.toolCallId).toBe("n1");
  });
});

describe("groupToolRuns", () => {
  const call = (toolCallId: string, status: string): ToolCallView => ({ toolCallId, title: toolCallId, name: "read", status, content: [], locations: [] });
  const statuses: Record<string, string> = {
    a: "completed", b: "completed", c: "completed", d: "completed", e: "completed", f: "failed",
    g: "completed", h: "completed", i: "completed", j: "completed", k: "completed", l: "completed", m: "in_progress",
  };
  const toolCalls = Object.fromEntries(Object.entries(statuses).map(([id, s]) => [id, call(id, s)]));
  const tool = (toolCallId: string): TranscriptItem => ({ kind: "tool", toolCallId });

  test("folds runs of 3+ completed calls; running, failed and pinned calls split runs and stay", () => {
    const items: TranscriptItem[] = [
      tool("a"), tool("b"), { kind: "assistant", text: "x" },
      tool("c"), tool("d"), tool("e"), tool("f"),
      tool("g"), tool("h"), tool("i"),
      tool("j"), tool("k"), tool("l"), tool("m"),
    ];
    expect(groupToolRuns(items, toolCalls, new Set(["i"]))).toEqual([
      tool("a"), tool("b"), { kind: "assistant", text: "x" },
      { kind: "toolGroup", toolCallIds: ["c", "d", "e"] }, tool("f"),
      tool("g"), tool("h"), tool("i"),
      { kind: "toolGroup", toolCallIds: ["j", "k", "l"] }, tool("m"),
    ]);
  });
});
