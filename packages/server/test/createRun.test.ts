import { wrapUntrustedText } from "@orch/protocol";
import { describe, expect, test } from "bun:test";
import { runNamePrompt } from "../src/createRun";
import { flowDef } from "./helpers";

describe("runNamePrompt", () => {
  test("wraps a long stored-wrapped PR title exactly once and keeps the instruction outside it", () => {
    const def = flowDef({
      inputs: [{ key: "pr", label: "PR", type: "github_pull_request" }],
      workspace: { kind: "github_checkout" },
      steps: [{ id: "review", name: "Review", kind: "prompt", prompt: "Review" }],
    });
    // Stored like `pullRequestInput`: title already wrapped server-side.
    const pr = { url: "https://github.com/acme/app/pull/7", repo: "acme/app", number: 7, title: wrapUntrustedText("t".repeat(300)), body: "" };
    const prompt = runNamePrompt(def, { pr });

    expect(prompt).toContain(`PR: acme/app#7 (https://github.com/acme/app/pull/7) ${wrapUntrustedText(`${"t".repeat(200)}…`)}`);
    // One wrapped block (the preamble names the tag but never opens one), closed before the instruction.
    expect(prompt.split("<untrusted_pr_text>\n")).toHaveLength(2);
    expect(prompt.split("</untrusted_pr_text>")).toHaveLength(2);
    expect(prompt.lastIndexOf("</untrusted_pr_text>")).toBeLessThan(prompt.indexOf("Reply with a short"));
  });
});
