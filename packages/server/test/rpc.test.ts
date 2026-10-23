import { describe, expect, test } from "bun:test";
import type { RunnerRpcCall } from "@orch/protocol";
import { PatCredentials } from "../src/github/credentials";
import { handleRunnerRpc, RunnerSession } from "../src/ws/runner";
import { addRun, addRunner, FakeLink, testDeps } from "./helpers";

interface Recorded {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

function fakeGitHub(): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      url,
      auth: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/repos/o/r")) return Response.json({ default_branch: "trunk" });
    if (url.endsWith("/repos/o/r/pulls")) return Response.json({ html_url: "https://github.com/o/r/pull/9", number: 9 }, { status: 201 });
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  return { fetch: fn as typeof fetch, calls };
}

const tokenCall = (runId: string): RunnerRpcCall => ({
  t: "rpc.call",
  rpcId: "c1",
  method: "github.token",
  params: { runId, repo: "o/r", access: "write" },
});

const prCall = (runId: string): RunnerRpcCall => ({
  t: "rpc.call",
  rpcId: "c2",
  method: "github.createPullRequest",
  params: { runId, repo: "o/r", head: "orch/abc", base: null, title: "feat: x", body: "body", draft: true },
});

describe("runner RPC authorization", () => {
  test("the runner holding an active owner run gets the token", async () => {
    const deps = testDeps({ credentials: new PatCredentials("ghp_secret") });
    const runId = addRun(deps, { status: "running", runnerId: "r1" });
    expect(await handleRunnerRpc(deps, "r1", tokenCall(runId))).toEqual({
      t: "rpc.result",
      rpcId: "c1",
      ok: true,
      result: { token: "ghp_secret" },
    });
  });

  test("forbidden for another runner, untrusted runs, finished runs and unknown runs", async () => {
    const deps = testDeps({ credentials: new PatCredentials("ghp_secret") });
    const held = addRun(deps, { status: "running", runnerId: "r1" });
    const untrusted = addRun(deps, { status: "running", runnerId: "r1", trust: "untrusted" });
    const finished = addRun(deps, { status: "cancelled", runnerId: "r1" });
    const forbidden = { t: "rpc.result", ok: false, error: "forbidden" };
    expect(await handleRunnerRpc(deps, "r2", tokenCall(held))).toMatchObject(forbidden);
    expect(await handleRunnerRpc(deps, "r1", tokenCall(untrusted))).toMatchObject(forbidden);
    expect(await handleRunnerRpc(deps, "r1", tokenCall(finished))).toMatchObject(forbidden);
    expect(await handleRunnerRpc(deps, "r1", tokenCall("nope"))).toMatchObject(forbidden);
    expect(await handleRunnerRpc(deps, "r1", prCall(untrusted))).toMatchObject({ ...forbidden, rpcId: "c2" });
  });

  test("missing credentials surface as an RPC error, not a crash", async () => {
    const deps = testDeps();
    const runId = addRun(deps, { status: "running", runnerId: "r1" });
    expect(await handleRunnerRpc(deps, "r1", tokenCall(runId))).toEqual({
      t: "rpc.result",
      rpcId: "c1",
      ok: false,
      error: "GitHub credentials not configured",
    });
  });

  test("createPullRequest resolves the default branch when base is null", async () => {
    const gh = fakeGitHub();
    const deps = testDeps({ credentials: new PatCredentials("ghp_secret"), fetch: gh.fetch });
    const runId = addRun(deps, { status: "running", runnerId: "r1" });
    expect(await handleRunnerRpc(deps, "r1", prCall(runId))).toEqual({
      t: "rpc.result",
      rpcId: "c2",
      ok: true,
      result: { url: "https://github.com/o/r/pull/9", number: 9 },
    });
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET https://gh.test/repos/o/r", "POST https://gh.test/repos/o/r/pulls"]);
    expect(gh.calls[1]).toMatchObject({
      auth: "Bearer ghp_secret",
      body: { title: "feat: x", body: "body", head: "orch/abc", base: "trunk", draft: true },
    });
  });

  test("rpc.call over the session replies with rpc.result on the same link", async () => {
    const deps = testDeps({ credentials: new PatCredentials("ghp_secret") });
    addRunner(deps, "r2");
    const runId = addRun(deps, { status: "running", runnerId: "r1" });
    const link = new FakeLink();
    await new RunnerSession(deps, "r2", link).handle(JSON.stringify(tokenCall(runId)));
    expect(link.sent).toEqual([{ t: "rpc.result", rpcId: "c1", ok: false, error: "forbidden" }]);
  });
});
