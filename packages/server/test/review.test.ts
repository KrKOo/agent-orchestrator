import { describe, expect, test } from "bun:test";
import type { Finding } from "@orch/protocol";
import { buildReview, commentableLines, formatFindingList } from "../src/github/review";

// Old file lines 1-12; new file: hunk 1 starts at 1, hunk 2 at 20.
const PATCH = [
  "@@ -1,4 +1,5 @@",
  " import os", // 1 context
  "-import sys", // deleted
  "+import json", // 2 added
  "+import subprocess", // 3 added
  " ", // 4 context (blank line)
  " def main():", // 5 context
  "@@ -18,3 +20,4 @@ def main():",
  "     x = 1", // 20 context
  "-    y = 2", // deleted
  "+    y = eval(input())", // 21 added
  "+    z = 3", // 22 added
  "     return x", // 23 context
  "\\ No newline at end of file",
].join("\n");

function finding(file: string, line: number, over: Partial<Finding> = {}): Finding {
  return { file, line, severity: "error", message: `issue at ${line}`, ...over };
}

describe("commentableLines", () => {
  test("collects added and context lines across hunks", () => {
    expect([...commentableLines(PATCH)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 20, 21, 22, 23]);
  });

  test("deleted-only hunks and missing patches yield nothing", () => {
    expect(commentableLines("@@ -3,2 +2,0 @@\n-a\n-b").size).toBe(0);
    expect(commentableLines(undefined).size).toBe(0);
  });

  test("hunk header without counts", () => {
    expect([...commentableLines("@@ -1 +1 @@\n-a\n+b")]).toEqual([1]);
  });
});

describe("buildReview", () => {
  const files = [{ filename: "app.py", patch: PATCH }, { filename: "logo.png" }];

  test("maps findings to commentable lines; the rest go to the body", () => {
    const findings = [
      finding("app.py", 21, { ruleId: "py.eval", message: "eval of user input, cc @admin" }),
      finding("app.py", 6, { severity: "warning" }), // past hunk 1: not commentable
      finding("app.py", 1, { severity: "info" }), // context line: commentable
      finding("logo.png", 1), // no patch
      finding("other.py", 3), // not in the PR
    ];
    const review = buildReview(findings, files);
    expect(review.comments).toEqual([
      { path: "app.py", line: 21, side: "RIGHT", body: "**error** (py.eval): eval of user input, cc @\u200badmin" },
      { path: "app.py", line: 1, side: "RIGHT", body: "**info**: issue at 1" },
    ]);
    expect(review.body.split("\n")[0]).toBe("Orchestrator found 5 findings.");
    expect(review.body).toContain("- `app.py:6` warning: issue at 6");
    expect(review.body).toContain("- `logo.png:1` error: issue at 1");
    expect(review.body).toContain("- `other.py:3` error: issue at 3");
    expect(review.body).not.toContain("app.py:21");
  });

  test("caps inline comments at 50 and overflows into the body in order", () => {
    const findings = Array.from({ length: 53 }, (_, i) => finding("app.py", 21, { message: `n${i}` }));
    const review = buildReview(findings, files);
    expect(review.comments).toHaveLength(50);
    expect(review.comments.at(-1)!.body).toBe("**error**: n49");
    expect(review.body).toContain("Orchestrator found 53 findings.");
    for (const i of [50, 51, 52]) expect(review.body).toContain(`- \`app.py:21\` error: n${i}`);
    expect(review.body).not.toContain("n49");
  });

  test("single finding, all inline: headline only", () => {
    const review = buildReview([finding("app.py", 2)], files);
    expect(review.comments).toHaveLength(1);
    expect(review.body).toBe("Orchestrator found 1 finding.");
  });
});

describe("formatFindingList", () => {
  test("collapses overflow into an 'and N more' line within the budget", () => {
    const findings = Array.from({ length: 100 }, (_, i) => finding("a.py", i + 1, { message: "x".repeat(50) }));
    const list = formatFindingList(findings, 500);
    expect(list.length).toBeLessThanOrEqual(500);
    const lines = list.split("\n");
    expect(lines.at(-1)).toBe(`- … and ${100 - (lines.length - 1)} more`);
  });

  test("flattens multi-line messages", () => {
    expect(formatFindingList([finding("a.py", 1, { message: "one\n\ntwo" })], 1000)).toBe("- `a.py:1` error: one two");
  });
});
