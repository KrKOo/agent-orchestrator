import { describe, expect, test } from "bun:test";
import type { Finding } from "@orch/protocol";
import {
  buildAnnotations,
  type CheckConclusion,
  checkConclusion,
  checkSummary,
  checkTitle,
  MAX_SUMMARY_CHARS,
} from "../src/github/report";

const err: Finding = { file: "a.py", line: 3, severity: "error", message: "bad" };
const warn: Finding = { file: "a.py", line: 4, severity: "warning", message: "meh" };
const info: Finding = { file: "b.py", line: 5, severity: "info", message: "fyi" };

/** Assert every opened fence is closed (CommonMark: closing run at least as long as the opener). */
function expectBalancedFences(md: string): number {
  let open: string | null = null;
  let blocks = 0;
  for (const line of md.split("\n")) {
    if (open === null) {
      const start = /^(`{3,})/.exec(line);
      if (start) {
        open = start[1]!;
        blocks++;
      }
    } else {
      const close = /^ {0,3}(`+)\s*$/.exec(line);
      if (close && close[1]!.length >= open.length) open = null;
    }
  }
  expect(open).toBeNull();
  return blocks;
}

describe("checkConclusion", () => {
  const cases: [Parameters<typeof checkConclusion>[0], Finding[], CheckConclusion][] = [
    ["cancelled", [err], "cancelled"],
    ["failed", [], "failure"],
    ["failed", [info], "failure"],
    ["succeeded", [warn, err], "failure"],
    ["succeeded", [info, warn], "neutral"],
    ["succeeded", [info], "success"],
    ["succeeded", [], "success"],
  ];
  for (const [status, findings, expected] of cases) {
    test(`${status} + [${findings.map((f) => f.severity).join(",")}] → ${expected}`, () => {
      expect(checkConclusion(status, findings)).toBe(expected);
    });
  }
});

describe("checkTitle", () => {
  test("formats each status", () => {
    expect(checkTitle("failed", "Step timed out after 60s", 1, 2)).toBe("Run failed: Step timed out after 60s");
    expect(checkTitle("failed", null, 0, 2)).toBe("Run failed: unknown error");
    expect(checkTitle("cancelled", null, 1, 2)).toBe("Cancelled");
    expect(checkTitle("succeeded", null, 2, 2)).toBe("2/2 steps");
  });
});

describe("checkSummary", () => {
  test("lists steps with sanitized outputs and outside findings", () => {
    const md = checkSummary(
      [
        { id: "review", name: "Review", status: "succeeded", output: "Looks fine @octocat\n```\ncode\n```" },
        { id: "sec", name: "Security", status: "running", output: null },
      ],
      [info],
    );
    expect(md).toBe(
      [
        "### Review — succeeded",
        "",
        "````",
        "Looks fine @\u200boctocat",
        "```",
        "code",
        "```",
        "````",
        "",
        "### Security — running",
        "",
        "### Findings outside the diff",
        "",
        "- `b.py:5` info: fyi",
      ].join("\n"),
    );
    expect(expectBalancedFences(md)).toBe(1);
  });

  test("caps at 60 000 chars with balanced fences", () => {
    const huge = "line with ```` fences and @user\n".repeat(5000); // ~160k chars
    const steps = [
      { id: "a", name: "A", status: "succeeded", output: huge },
      { id: "b", name: "B", status: "succeeded", output: "short output" },
      { id: "c", name: "C", status: "failed", output: `\`\`\`\`\`\`${huge}` },
    ];
    const extras = Array.from({ length: 2000 }, (_, i): Finding => ({ ...warn, line: i + 1, message: "x".repeat(100) }));
    const md = checkSummary(steps, extras);
    expect(md.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(md.length).toBeGreaterThan(MAX_SUMMARY_CHARS - 500);
    expect(expectBalancedFences(md)).toBe(3);
    expect(md).toContain("short output");
    expect(md).toContain("… (truncated)");
    expect(md).toContain("### Findings outside the diff");
    expect(md).toMatch(/- … and \d+ more$/);
    expect(md).not.toContain("@user");
  });

  test("fits exactly when everything is small", () => {
    const md = checkSummary([{ id: "a", name: "A", status: "succeeded", output: "ok" }]);
    expect(md).toBe("### A — succeeded\n\n```\nok\n```");
  });
});

describe("buildAnnotations", () => {
  test("annotates changed files only and maps severities", () => {
    const findings: Finding[] = [
      { ...err, endLine: 7, ruleId: "py.eval", message: "ping @admin" },
      warn,
      { ...info, file: "a.py" },
      { ...err, file: "untouched.py" },
    ];
    const { annotations, outside } = buildAnnotations(findings, new Set(["a.py"]));
    expect(annotations).toEqual([
      {
        path: "a.py",
        start_line: 3,
        end_line: 7,
        annotation_level: "failure",
        message: "ping @\u200badmin",
        title: "py.eval",
      },
      { path: "a.py", start_line: 4, end_line: 4, annotation_level: "warning", message: "meh" },
      { path: "a.py", start_line: 5, end_line: 5, annotation_level: "notice", message: "fyi" },
    ]);
    expect(outside).toEqual([{ ...err, file: "untouched.py" }]);
  });

  test("truncates neutralized messages to 2000 chars", () => {
    const { annotations } = buildAnnotations([{ ...err, message: "@".repeat(2000) }], new Set(["a.py"]));
    expect(annotations[0]!.message.length).toBeLessThanOrEqual(2000);
  });
});
