import { describe, expect, test } from "bun:test";
import type { WorkspaceInfo } from "@orch/protocol";
import { checkoutCommand } from "../src/routes/RunView";

describe("checkoutCommand", () => {
  test("worktree: fetch and checkout the orchestrator branch", () => {
    const ws: WorkspaceInfo = { path: "/runner/worktrees/01ABC", branch: "orch/01abc", repo: "acme/widget" };
    expect(checkoutCommand(ws)).toBe("git fetch origin orch/01abc && git checkout orch/01abc");
  });

  test("direct path without a branch/repo falls back to cd", () => {
    const ws: WorkspaceInfo = { path: "/Users/me/Documents/repo" };
    expect(checkoutCommand(ws)).toBe("cd /Users/me/Documents/repo");
  });

  test("branch without a pushed repo is not fetchable; fall back to cd", () => {
    const ws: WorkspaceInfo = { path: "/runner/worktrees/01ABC", branch: "orch/01abc" };
    expect(checkoutCommand(ws)).toBe("cd /runner/worktrees/01ABC");
  });
});
