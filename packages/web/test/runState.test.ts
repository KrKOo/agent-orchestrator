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
      ev({ type: "intervention.request", stepId: "gate", payload: { requestId: "i1", message: "review it" } }),
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
});
