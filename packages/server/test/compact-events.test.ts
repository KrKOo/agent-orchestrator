import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schema } from "../src/db";
import { eventsAfter } from "../src/ws/browser";
import { addRun, flowDef, testDeps } from "./helpers";

// createDb already applied it to an empty table; re-running it compacts rows inserted since (it is idempotent).
const MIGRATION = readFileSync(join(import.meta.dir, "../drizzle/0007_compact_run_events.sql"), "utf8").split("--> statement-breakpoint");

const update = (stepId: string, text: string, tick: number, status = "in_progress") => ({
  stepId,
  type: "acp.update",
  payload: {
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status,
      content: [{ type: "content", content: { type: "text", text } }],
      rawOutput: { details: { totalDurationMs: tick } },
    },
  },
});
const log = (stepId: string, stream: string) => ({ stepId, type: "sandbox.log", payload: { stream, text: `${stream} of ${stepId}` } });

describe("0007_compact_run_events backport", () => {
  test("drops slash stdout logs, unfinished rawOutput, and repeated unfinished tool updates", () => {
    const deps = testDeps();
    const runId = addRun(deps, {
      definition: flowDef({
        steps: [
          { id: "slash", name: "Slash", kind: "slash", command: "review" },
          { id: "sh", name: "Shell", kind: "shell", command: "echo hi" },
          { id: "agent", name: "Agent", kind: "prompt", prompt: "go" },
        ],
      }),
    });
    const rows = [
      log("slash", "stdout"),
      log("slash", "stderr"),
      log("sh", "stdout"),
      update("agent", "A", 1),
      update("agent", "A", 2),
      update("agent", "B", 3),
      update("agent", "A", 4),
      update("slash", "A", 5),
      update("agent", "A", 6, "completed"),
    ];
    deps.db
      .insert(schema.runEvents)
      .values(rows.map((r, i) => ({ runId, seq: i + 1, ts: i, ...r })))
      .run();

    for (const stmt of MIGRATION) deps.db.$client.run(stmt);

    const kept = eventsAfter(deps, runId, 0);
    expect(kept.map((e) => e.seq)).toEqual([2, 3, 4, 6, 7, 8, 9]);
    const raw = (seq: number) => {
      const ev = kept.find((e) => e.seq === seq);
      return ev?.type === "acp.update" ? ev.payload.update.rawOutput : "not a tool update";
    };
    expect([4, 6, 7, 8].map(raw)).toEqual([undefined, undefined, undefined, undefined]);
    expect(raw(9)).toEqual({ details: { totalDurationMs: 6 } });
  });
});
