import { describe, expect, test } from "bun:test";
import { OmpJsonTranslator } from "../src/omp-json";

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

describe("OmpJsonTranslator", () => {
  test("agent_end with non-block message content still yields the final assistant text", () => {
    const t = new OmpJsonTranslator();
    t.push(
      line({
        type: "agent_end",
        messages: [
          { role: "user", content: [{ type: "text", text: "/plan go" }] },
          { role: "assistant", content: [{ type: "text", text: "draft" }] },
          // omp delivers finished background jobs as `custom` messages whose content is a plain string.
          { role: "custom", customType: "async-result", content: "<system-notice>bg_1 done</system-notice>" },
          { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "Plan " }, { type: "text", text: "written." }] },
        ],
      }),
    );
    expect(t.result()).toBe("Plan written.");
  });

  test("no result when the final assistant message has no text", () => {
    const t = new OmpJsonTranslator();
    t.push(line({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash" }] }] }));
    expect(t.result()).toBeUndefined();
  });
});
