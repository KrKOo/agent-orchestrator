import { describe, expect, test } from "bun:test";
import { neutralizeMentions, sanitizeForMarkdown } from "../src/github/sanitize";

/** Split a fenced block into fence + content, asserting nothing inside can close it early. */
function unfence(md: string): { fence: string; content: string } {
  const lines = md.split("\n");
  const fence = lines[0]!;
  expect(fence).toMatch(/^`{3,}$/);
  expect(lines.at(-1)).toBe(fence);
  const inner = lines.slice(1, -1);
  for (const line of inner) {
    const close = /^ {0,3}(`+)\s*$/.exec(line);
    if (close) expect(close[1]!.length).toBeLessThan(fence.length);
  }
  return { fence, content: inner.join("\n") };
}

describe("sanitizeForMarkdown", () => {
  test("neutralizes mentions and uses a minimum 3-backtick fence", () => {
    const md = sanitizeForMarkdown("ping @octocat and @org/team");
    const { fence, content } = unfence(md);
    expect(fence).toBe("```");
    expect(content).toBe("ping @\u200boctocat and @\u200borg/team");
    expect(content).not.toMatch(/@[a-z]/);
  });

  test("survives inner ``` and ```` fences", () => {
    const text = "before\n```\ncode @x\n```\n````js\nmore\n````\nafter `inline`";
    const md = sanitizeForMarkdown(text);
    const { fence, content } = unfence(md);
    expect(fence).toBe("`````");
    expect(content).toBe(text.replaceAll("@", "@\u200b"));
  });

  test("fence is one longer than the longest backtick run", () => {
    expect(unfence(sanitizeForMarkdown("a ``````` b")).fence).toBe("`".repeat(8));
    expect(unfence(sanitizeForMarkdown("``")).fence).toBe("```");
    expect(unfence(sanitizeForMarkdown("")).content).toBe("");
  });
});

describe("neutralizeMentions", () => {
  test("neutralizes without truncating short text", () => {
    expect(neutralizeMentions("hi @bob")).toBe("hi @\u200bbob");
  });

  test("truncates to max chars with an ellipsis", () => {
    const out = neutralizeMentions("x".repeat(5000));
    expect(out.length).toBe(2000);
    expect(out.endsWith("…")).toBe(true);
    const mentions = neutralizeMentions("@".repeat(10), 12);
    expect(mentions.length).toBeLessThanOrEqual(12);
    expect(mentions.endsWith("…")).toBe(true);
  });

  test("never leaves a dangling surrogate", () => {
    const out = neutralizeMentions("😀".repeat(10), 6);
    expect(out.length).toBeLessThanOrEqual(6);
    expect(out).toBe("😀😀…");
  });
});
