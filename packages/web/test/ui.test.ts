import { wrapUntrustedText } from "@orch/protocol";
import { describe, expect, test } from "bun:test";
import { githubRefsOf } from "../src/ui";

describe("githubRefsOf", () => {
  test("maps input types to issue/pull_request kinds and unwraps stored PR titles", () => {
    const refs = githubRefsOf({
      definition: {
        inputs: [
          { key: "issue", type: "github_issue" },
          { key: "pr", type: "github_pull_request" },
          { key: "note", type: "text" },
        ],
      },
      inputs: {
        issue: { repo: "acme/app", number: 42, title: "Crash on boot", url: "https://github.com/acme/app/issues/42" },
        pr: { repo: "acme/app", number: 7, title: wrapUntrustedText("Fix boot"), url: "https://github.com/acme/app/pull/7" },
        note: "free text",
      },
    });
    expect(refs).toEqual([
      { kind: "issue", repo: "acme/app", number: 42, title: "Crash on boot", url: "https://github.com/acme/app/issues/42" },
      { kind: "pull_request", repo: "acme/app", number: 7, title: "Fix boot", url: "https://github.com/acme/app/pull/7" },
    ]);
  });
});
