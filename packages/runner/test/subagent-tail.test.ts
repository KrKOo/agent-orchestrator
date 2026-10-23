import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SubagentEvent, SubagentTail } from "../src/subagent-tail";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "subagent-tail-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("tails sibling-stem subagent transcripts with partial lines", async () => {
  const events: SubagentEvent[] = [];
  const tail = new SubagentTail(dir, (e) => events.push(e));

  writeFileSync(join(dir, "S.jsonl"), `${JSON.stringify({ type: "session_init", agent: "main", task: "" })}\n`);
  mkdirSync(join(dir, "S"));
  const init = { type: "session_init", agent: "scout", task: "List files", resolvedModel: "anthropic/claude-haiku-4-5", modelRole: "smol" };
  const message = {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me look", thinkingSignature: "sig" },
        { type: "text", text: "Listing now" },
        { type: "toolCall", id: "t1", name: "find", intent: "Listing files", arguments: { pattern: "**/*" } },
      ],
    },
  };
  const line = JSON.stringify(message);
  const half = Math.floor(line.length / 2);
  writeFileSync(join(dir, "S", "Scout1.jsonl"), `${JSON.stringify(init)}\n${line.slice(0, half)}`);
  mkdirSync(join(dir, "other"));
  writeFileSync(join(dir, "other", "x.jsonl"), `${JSON.stringify(init)}\n`);

  await tail.poll();
  expect(events).toEqual([
    {
      type: "subagent.started",
      payload: { agentId: "Scout1", agent: "scout", task: "List files", model: "anthropic/claude-haiku-4-5" },
    },
  ]);

  appendFileSync(join(dir, "S", "Scout1.jsonl"), `${line.slice(half)}\n`);
  await tail.poll();
  expect(events).toHaveLength(2);
  expect(events[1]).toEqual({
    type: "subagent.message",
    payload: {
      agentId: "Scout1",
      role: "assistant",
      blocks: [
        { type: "thinking", text: "Let me look" },
        { type: "text", text: "Listing now" },
        { type: "toolCall", id: "t1", name: "find", intent: "Listing files", arguments: { pattern: "**/*" } },
      ],
    },
  });

  // Tool results are truncated; unknown entries ignored; nothing re-emitted.
  appendFileSync(
    join(dir, "S", "Scout1.jsonl"),
    `${JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(5000) }] } })}\n${JSON.stringify({ type: "model_change" })}\n`,
  );
  await tail.poll();
  expect(events).toHaveLength(3);
  expect(events[2]).toEqual({
    type: "subagent.message",
    payload: { agentId: "Scout1", role: "toolResult", blocks: [{ type: "toolResult", text: "x".repeat(4000) }] },
  });
  await tail.stop();
});
