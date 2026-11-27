import { describe, expect, test } from "bun:test";
import { GitHubApi, GitHubError } from "../src/github/api";
import { resolveConflictsDefinition, RESOLVE_CONFLICTS_FLOW_ID } from "../src/builtin-flows";

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

type Route = (method: string, path: string, body: unknown) => Response;

/** Fake fetch with a per-test swappable `route`; records method, path+query and JSON body. */
function fakeGitHub(): { fetch: typeof fetch; calls: Recorded[]; route(next: Route): void } {
  let current: Route = () => Response.json({}, { status: 404 });
  const calls: Recorded[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname + url.search, body });
    return current(method, url.pathname + url.search, body);
  };
  return { fetch: fn as typeof fetch, calls, route: (next: Route) => void (current = next) };
}

const ok = (data: unknown, status = 200) => Response.json(data, { status });

describe("GitHubApi task helpers", () => {
  test("createIssue posts title and body and returns url and number", async () => {
    const gh = fakeGitHub();
    gh.route((_m, path) => (/\/repos\/o\/r\/issues$/.test(path) ? ok({ html_url: "https://github.com/o/r/issues/5", number: 5 }) : ok({}, 404)));
    const api = new GitHubApi(gh.fetch, "https://gh.test");
    const out = await api.createIssue("tok", "o/r", { title: "Fix it", body: "Please" });
    expect(out).toEqual({ url: "https://github.com/o/r/issues/5", number: 5 });
    expect(gh.calls).toEqual([{ method: "POST", path: "/repos/o/r/issues", body: { title: "Fix it", body: "Please" } }]);
  });

  test("getBranchSha returns the sha and null on 404", async () => {
    const gh = fakeGitHub();
    gh.route((_m, path) => {
      if (path === "/repos/o/r/git/ref/heads/main") return ok({ object: { sha: SHA } });
      return ok({ message: "Not Found" }, 404);
    });
    const api = new GitHubApi(gh.fetch, "https://gh.test");
    expect(await api.getBranchSha("tok", "o/r", "main")).toBe(SHA);
    expect(await api.getBranchSha("tok", "o/r", "nope")).toBeNull();
    // Branch names with slashes stay one path (GitHub takes the raw ref there).
    await api.getBranchSha("tok", "o/r", "orch/task-x");
    expect(gh.calls[2]!.path).toBe("/repos/o/r/git/ref/heads/orch/task-x");
  });

  test("createBranch posts the full ref and tolerates an already-exists 422", async () => {
    const gh = fakeGitHub();
    let n = 0;
    gh.route((_m, _path, body) => {
      n++;
      if (n === 1) return ok({ ref: "refs/heads/orch/task-x", object: { sha: BASE_SHA } }, 201);
      return ok({ message: "Reference already exists" }, 422);
    });
    const api = new GitHubApi(gh.fetch, "https://gh.test");
    await api.createBranch("tok", "o/r", "orch/task-x", BASE_SHA);
    expect(gh.calls[0]).toEqual({ method: "POST", path: "/repos/o/r/git/refs", body: { ref: "refs/heads/orch/task-x", sha: BASE_SHA } });
    // Concurrent creations (two workers ensuring the same integration branch) resolve instead of throwing.
    await expect(api.createBranch("tok", "o/r", "orch/task-x", BASE_SHA)).resolves.toBeUndefined();
    expect(n).toBe(2);
  });

  test("createBranch surfaces other 422s", async () => {
    const gh = fakeGitHub();
    gh.route(() => ok({ message: "Invalid sha" }, 422));
    const api = new GitHubApi(gh.fetch, "https://gh.test");
    const err = await api.createBranch("tok", "o/r", "orch/task-x", "bad").catch((e: unknown) => e);
    if (!(err instanceof GitHubError)) throw new Error(`expected GitHubError, got ${String(err)}`);
    expect(err.status).toBe(422);
  });

  test("mergePullRequest sends squash with sha and title; 405 surfaces as GitHubError 405", async () => {
    const gh = fakeGitHub();
    gh.route((_m, path) => (path === "/repos/o/r/pulls/7/merge" ? ok({ sha: SHA, merged: true }) : ok({}, 404)));
    const api = new GitHubApi(gh.fetch, "https://gh.test");
    await expect(api.mergePullRequest("tok", "o/r", 7, { method: "squash", sha: BASE_SHA, commitTitle: "Squash" })).resolves.toEqual({ sha: SHA });
    expect(gh.calls[0]).toEqual({
      method: "PUT",
      path: "/repos/o/r/pulls/7/merge",
      body: { merge_method: "squash", sha: BASE_SHA, commit_title: "Squash" },
    });

    // An unmergeable PR is GitHub's 405, surfaced as a GitHubError with that status.
    const notMergeable = fakeGitHub();
    notMergeable.route(() => ok({ message: "Pull Request is not mergeable" }, 405));
    const api2 = new GitHubApi(notMergeable.fetch, "https://gh.test");
    const err = await api2.mergePullRequest("tok", "o/r", 7, { method: "squash" }).catch((e: unknown) => e);
    if (!(err instanceof GitHubError)) throw new Error(`expected GitHubError, got ${String(err)}`);
    expect(err.status).toBe(405);
  });

  test("findOpenPull queries state, head and base and returns null when empty", async () => {
    const gh = fakeGitHub();
    gh.route((_m, path) => (path.startsWith("/repos/o/r/pulls?") ? ok([{ number: 3, html_url: "https://github.com/o/r/pull/3" }]) : ok({}, 404)));
    const api = new GitHubApi(gh.fetch, "https://gh.test");
    expect(await api.findOpenPull("tok", "o/r", "orch/task-x", "main")).toEqual({ number: 3, url: "https://github.com/o/r/pull/3" });
    expect(gh.calls[0]!.path).toBe(`/repos/o/r/pulls?state=open&head=${encodeURIComponent("o:orch/task-x")}&base=${encodeURIComponent("main")}`);
    const none = fakeGitHub();
    none.route((_m, path) => (path.startsWith("/repos/o/r/pulls?") ? ok([]) : ok({}, 404)));
    const api2 = new GitHubApi(none.fetch, "https://gh.test");
    expect(await api2.findOpenPull("tok", "o/r", "orch/task-x", "main")).toBeNull();
  });

  test("getPullStatus aggregates checks: failure, pending, none and success", async () => {
    const prBody = (head: Record<string, unknown>) => ({
      html_url: "https://github.com/o/r/pull/7",
      number: 7,
      state: "open",
      merged: false,
      draft: false,
      mergeable: true,
      mergeable_state: "clean",
      head,
      base: { ref: "main", sha: BASE_SHA },
    });
    const HEAD = { ref: "orch/task-x", sha: SHA, repo: { full_name: "o/r" } };
    const checks =
      (runs: unknown[], statuses: unknown[], head: Record<string, unknown> = HEAD) =>
      (_m: string, path: string): Response => {
        if (path === "/repos/o/r/pulls/7") return ok(prBody(head));
        if (path === `/repos/o/r/commits/${SHA}/check-runs?per_page=100&page=1`) return ok({ total_count: runs.length, check_runs: runs });
        if (path === `/repos/o/r/commits/${SHA}/status?per_page=100&page=1`) return ok({ state: "pending", statuses });
        return ok({}, 404);
      };

    // failure: a failing conclusion wins over a pending run; PR fields pass through.
    const fail = fakeGitHub();
    fail.route(
      checks([
        { name: "lint", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure" },
        { name: "build", status: "in_progress", conclusion: null },
      ], [{ state: "pending", context: "ci/slow" }]),
    );
    const s1 = await new GitHubApi(fail.fetch, "https://gh.test").getPullStatus("tok", "o/r", 7);
    expect(s1.checks).toEqual({ state: "failure", failing: ["test"], pending: [] });
    expect(s1).toMatchObject({ url: "https://github.com/o/r/pull/7", number: 7, state: "open", merged: false, draft: false, mergeable: true, mergeableState: "clean" });
    expect(s1.head).toEqual({ ref: "orch/task-x", sha: SHA, repo: "o/r" });
    expect(s1.base).toEqual({ ref: "main", sha: BASE_SHA });

    // pending: only in-progress runs and pending statuses.
    const pend = fakeGitHub();
    pend.route(checks([{ name: "test", status: "queued", conclusion: null }], [{ state: "pending", context: "ci/slow" }]));
    const s2 = await new GitHubApi(pend.fetch, "https://gh.test").getPullStatus("tok", "o/r", 7);
    expect(s2.checks).toEqual({ state: "pending", failing: [], pending: ["test", "ci/slow"] });

    // none: no checks or statuses at all.
    const bare = fakeGitHub();
    bare.route(checks([], []));
    const s3 = await new GitHubApi(bare.fetch, "https://gh.test").getPullStatus("tok", "o/r", 7);
    expect(s3.checks).toEqual({ state: "none", failing: [], pending: [] });

    // success: completed non-failing conclusions and success statuses.
    const good = fakeGitHub();
    good.route(checks([{ name: "lint", status: "completed", conclusion: "success" }], [{ state: "success", context: "ci/quick" }]));
    const s4 = await new GitHubApi(good.fetch, "https://gh.test").getPullStatus("tok", "o/r", 7);
    expect(s4.checks).toEqual({ state: "success", failing: [], pending: [] });

    // error statuses and timed_out / startup_failure conclusions count as failures too.
    const bad = fakeGitHub();
    bad.route(
      checks(
        [
          { name: "ci", status: "completed", conclusion: "timed_out" },
          { name: "deploy", status: "completed", conclusion: "startup_failure" },
        ],
        [{ state: "error", context: "hook" }],
      ),
    );
    const s5 = await new GitHubApi(bad.fetch, "https://gh.test").getPullStatus("tok", "o/r", 7);
    expect(s5.checks).toEqual({ state: "failure", failing: ["ci", "deploy", "hook"], pending: [] });

    // A deleted fork head repo does not break the read.
    const fork = fakeGitHub();
    fork.route(checks([], [], { ref: "patch", sha: SHA, repo: null }));
    const s6 = await new GitHubApi(fork.fetch, "https://gh.test").getPullStatus("tok", "o/r", 7);
    expect(s6.head.repo).toBeNull();
    expect(s6.checks.state).toBe("none");

    // A failure past the first page of check runs (and a pending status past the first status page) still counts.
    const many = fakeGitHub();
    const greens = Array.from({ length: 100 }, (_, i) => ({ name: `ok${i}`, status: "completed", conclusion: "success" }));
    const okStatuses = Array.from({ length: 100 }, (_, i) => ({ state: "success", context: `s${i}` }));
    many.route((_m, path) => {
      if (path === "/repos/o/r/pulls/7") return ok(prBody(HEAD));
      const runs = `/repos/o/r/commits/${SHA}/check-runs?per_page=100&page=`;
      if (path === `${runs}1`) return ok({ total_count: 101, check_runs: greens });
      if (path === `${runs}2`) return ok({ total_count: 101, check_runs: [{ name: "late", status: "completed", conclusion: "failure" }] });
      const st = `/repos/o/r/commits/${SHA}/status?per_page=100&page=`;
      if (path === `${st}1`) return ok({ state: "pending", statuses: okStatuses });
      if (path === `${st}2`) return ok({ state: "pending", statuses: [{ state: "pending", context: "slow" }] });
      return ok({}, 404);
    });
    const s7 = await new GitHubApi(many.fetch, "https://gh.test").getPullStatus("tok", "o/r", 7);
    expect(s7.checks).toEqual({ state: "failure", failing: ["late"], pending: [] });
    expect(many.calls.map((c) => c.path).filter((p) => p.includes("page=2"))).toHaveLength(2);
  });
});

describe("resolveConflictsDefinition", () => {
  const MODELS = { model: "anthropic/claude-sonnet-4-5" };

  test("has the contract id, inputs and step sequence", () => {
    const def = resolveConflictsDefinition("/repos/task", MODELS);
    expect(RESOLVE_CONFLICTS_FLOW_ID).toBe("builtin:resolve-conflicts");
    expect(def.name).toBe("Resolve conflicts");
    expect(def.inputs.map((i) => i.key)).toEqual(["pr_url", "head", "base", "onto"]);
    for (const input of def.inputs) expect(input.required).toBe(true);
    expect(def.workspace).toEqual({ kind: "local_path", path: "/repos/task", isolation: "worktree", access: "rw", baseRef: "HEAD" });
    expect(def.harness).toEqual({ id: "omp", ...MODELS });
    expect(def.steps.map((s) => s.kind)).toEqual(["prompt", "git_push"]);
    const first = def.steps[0]!;
    if (first.kind !== "prompt") throw new Error("first step must be a prompt");
    expect(first.structured?.fields.map((f) => f.name)).toEqual(["summary", "checks"]);
    expect(def.steps[1]!.id).toBe("push");
  });

  test("the prompt tells the agent the worktree, rebase target, checks, commit and no-push rules", () => {
    const def = resolveConflictsDefinition("/repos/task", MODELS);
    const first = def.steps[0]!;
    if (first.kind !== "prompt") throw new Error("first step must be a prompt");
    expect(first.timeoutSec).toBe(3600);
    // The prompt is rendered per run, so it references the inputs by template name.
    for (const ref of ["inputs.pr_url", "inputs.head", "inputs.base", "inputs.onto"]) {
      expect(first.prompt).toContain(`{{${ref}}}`);
    }
    expect(first.prompt).toContain("worktree");
    expect(first.prompt).toContain("Rebase");
    expect(first.prompt).toContain("never push");
    // The git_push step does the pushing; no git_commit or github_pr steps exist.
    expect(def.steps.some((s) => s.kind === "git_commit")).toBe(false);
    expect(def.steps.some((s) => s.kind === "github_pr")).toBe(false);
  });
});
