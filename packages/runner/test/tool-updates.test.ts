import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@orch/protocol";
import { ToolUpdateCompactor } from "../src/tool-updates";

const progress = (text: string, tick: number, status = "in_progress"): SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId: "t1",
  status,
  content: [{ type: "content", content: { type: "text", text } }],
  rawOutput: { details: { totalDurationMs: tick } },
});

describe("ToolUpdateCompactor", () => {
  test("unfinished updates lose rawOutput and repeats are dropped; changes and reverts are kept", () => {
    const c = new ToolUpdateCompactor();
    const kept = [progress("A", 1), progress("A", 2), progress("B", 3), progress("A", 4), progress("A", 5)].map((u) => c.compact(u, "s1"));
    expect(kept.map((u) => (u ? JSON.stringify(u.content) : null))).toEqual([
      JSON.stringify(progress("A", 0).content),
      null,
      JSON.stringify(progress("B", 0).content),
      JSON.stringify(progress("A", 0).content),
      null,
    ]);
    expect(kept.every((u) => u === null || !("rawOutput" in u))).toBe(true);
  });

  test("finished updates pass through whole, and tracking restarts after them", () => {
    const c = new ToolUpdateCompactor();
    c.compact(progress("A", 1), "s1");
    expect(c.compact(progress("A", 2, "completed"), "s1")).toEqual(progress("A", 2, "completed"));
    expect(c.compact(progress("A", 3), "s1")).not.toBeNull();
  });

  test("the same tool call id in another step is tracked separately", () => {
    const c = new ToolUpdateCompactor();
    c.compact(progress("A", 1), "s1");
    expect(c.compact(progress("A", 2), "s2")).not.toBeNull();
  });

  test("other updates pass through unchanged", () => {
    const c = new ToolUpdateCompactor();
    const chunk = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } };
    expect(c.compact(chunk, "s1")).toBe(chunk);
    expect(c.compact(chunk, "s1")).toBe(chunk);
  });
});
