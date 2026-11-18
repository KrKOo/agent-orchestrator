import { wrapUntrustedText } from "@orch/protocol";
import { describe, expect, test } from "bun:test";
import { documentTitle, formatRelative, githubRefsOf } from "../src/ui";

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

describe("formatRelative", () => {
  const now = Date.UTC(2026, 10, 18, 12, 0, 0);
  const ago = (ms: number) => formatRelative(now - ms, now);
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;

  test("buckets floor at each unit boundary", () => {
    expect(ago(9_999)).toBe("just now");
    expect(ago(10 * S)).toBe("10s ago");
    expect(ago(59_999)).toBe("59s ago");
    expect(ago(M)).toBe("1m ago");
    expect(ago(H - 1)).toBe("59m ago");
    expect(ago(H)).toBe("1h ago");
    expect(ago(D - 1)).toBe("23h ago");
    expect(ago(D)).toBe("1d ago");
    expect(ago(7 * D - 1)).toBe("6d ago");
  });

  test("a week or older shows the date; future timestamps (clock skew) read as just now", () => {
    expect(ago(7 * D)).toBe(new Date(now - 7 * D).toLocaleDateString());
    expect(ago(-5 * M)).toBe("just now");
  });
});

describe("documentTitle", () => {
  test("prefixes the count of runs waiting for the user only when there are any", () => {
    expect(documentTitle("Runs", 0)).toBe("Runs — Agent Orchestrator");
    expect(documentTitle("Runs", 3)).toBe("(3) Runs — Agent Orchestrator");
    expect(documentTitle(null, 2)).toBe("(2) Agent Orchestrator");
  });
});
