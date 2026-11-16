import { afterEach, describe, expect, jest, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Catalog, FlowRow, RunDetail, RunRow } from "@orch/protocol";
import { FS_LIST_TIMEOUT_MS } from "../src/api/runners";
import { createApp } from "../src/app";
import { schema } from "../src/db";
import type { AppDeps } from "../src/deps";
import { PatCredentials } from "../src/github/credentials";
import { eventsAfter } from "../src/ws/browser";
import { addRun, caps, connectRunner, flowDef, testDeps } from "./helpers";

const flowBody = {
  name: "Issue to commit",
  inputs: [
    { key: "issue", label: "Issue", type: "github_issue" },
    { key: "note", label: "Note", type: "text", required: false },
  ],
  workspace: { kind: "local_path", path: "/Users/me/Documents/repo" },
  harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
  steps: [{ id: "impl", name: "Implement", kind: "prompt", prompt: "Fix {{inputs.issue.title}} ({{inputs.note}})" }],
};

function client(deps: AppDeps) {
  const app = createApp(deps);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

function issueFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${String(input)} ${new Headers(init?.headers).get("authorization") ?? "anon"}`);
    if (String(input).endsWith("/repos/acme/app/issues/42")) {
      return Response.json({ html_url: "https://github.com/acme/app/issues/42", number: 42, title: "Crash", body: null });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
}

describe("flows API", () => {
  test("create, update (version bump), validation errors, delete", async () => {
    const call = client(testDeps());
    const created = await call("POST", "/api/flows", flowBody);
    expect(created.status).toBe(201);
    const flow = created.json as FlowRow;
    expect(flow).toMatchObject({ name: "Issue to commit", version: 1 });
    expect(flow.definition.sandbox.network.mode).toBe("gateway_only"); // defaults applied

    const bad = await call("PUT", `/api/flows/${flow.id}`, {
      ...flowBody,
      steps: [{ id: "impl", name: "x", kind: "prompt", prompt: "{{steps.later.output}}" }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.errors[0]).toContain("steps.later.output");

    const updated = await call("PUT", `/api/flows/${flow.id}`, { ...flowBody, name: "Renamed" });
    expect(updated.json).toMatchObject({ id: flow.id, name: "Renamed", version: 2 });
    expect((await call("GET", "/api/flows")).json.map((f: FlowRow) => f.name)).toEqual(["Renamed"]);

    expect((await call("POST", "/api/flows", "{")).status).toBe(400);
    expect((await call("DELETE", `/api/flows/${flow.id}`)).status).toBe(204);
    expect((await call("GET", `/api/flows/${flow.id}`)).status).toBe(404);
  });
});

describe("runs API", () => {
  test("starting a run validates inputs, resolves the GitHub issue and assigns it to an eligible runner", async () => {
    const calls: string[] = [];
    const deps = testDeps({ credentials: new PatCredentials("ghp_x"), fetch: issueFetch(calls) });
    const link = connectRunner(deps, "r1", caps());
    const call = client(deps);
    const flow = (await call("POST", "/api/flows", flowBody)).json as FlowRow;

    const missing = await call("POST", `/api/flows/${flow.id}/runs`, { inputs: { stray: "1" } });
    expect(missing.status).toBe(400);
    expect(missing.json.errors).toEqual(["inputs.stray: not declared by the flow", "inputs.issue: required"]);

    const badUrl = await call("POST", `/api/flows/${flow.id}/runs`, { inputs: { issue: "https://gitlab.com/a/b/issues/1" } });
    expect(badUrl).toEqual({ status: 400, json: { error: "Invalid GitHub issue URL" } });

    const notFound = await call("POST", `/api/flows/${flow.id}/runs`, { inputs: { issue: "https://github.com/acme/app/issues/7" } });
    expect(notFound.status).toBe(400);
    expect(notFound.json.error).toContain("404");

    const ok = await call("POST", `/api/flows/${flow.id}/runs`, { inputs: { issue: "https://github.com/acme/app/issues/42" } });
    expect(ok.status).toBe(201);
    const run = ok.json as RunRow;
    expect(run).toMatchObject({ flowId: flow.id, flowName: "Issue to commit", trust: "owner", triggerKind: "manual" });
    expect(run.inputs).toEqual({
      issue: { url: "https://github.com/acme/app/issues/42", repo: "acme/app", number: 42, title: "Crash", body: "" },
      note: "",
    });
    expect(calls.at(-1)).toBe("https://gh.test/repos/acme/app/issues/42 Bearer ghp_x");
    expect(run).toMatchObject({ status: "assigned", runnerId: "r1" });
    expect(link.of("job.assign")[0]!.run.inputs).toEqual(run.inputs);

    const detail = (await call("GET", `/api/runs/${run.id}`)).json as RunDetail;
    expect(detail.steps.map((s) => [s.stepId, s.status])).toEqual([["impl", "pending"]]);
    expect((await call("GET", `/api/runs?flowId=${flow.id}`)).json.map((r: RunRow) => r.id)).toEqual([run.id]);
    expect((await call("GET", "/api/runs?flowId=other")).json).toEqual([]);
  });

  test("runs accept a name or autoName at creation, never both, and expose both on the row", async () => {
    const deps = testDeps();
    connectRunner(deps, "r1", caps());
    const call = client(deps);
    const flow = (await call("POST", "/api/flows", {
      ...flowBody,
      inputs: [{ key: "note", label: "Note", type: "text", required: false }],
      steps: [{ id: "impl", name: "Implement", kind: "prompt", prompt: "Do {{inputs.note}}" }],
    })).json as FlowRow;
    const start = (body: Record<string, unknown>) => call("POST", `/api/flows/${flow.id}/runs`, body);

    const named = await start({ name: "Fix the crash", inputs: {} });
    expect(named.status).toBe(201);
    expect(named.json).toMatchObject({ name: "Fix the crash", autoName: false });

    const auto = await start({ autoName: true, inputs: {} });
    expect(auto.status).toBe(201);
    expect(auto.json).toMatchObject({ name: null, autoName: true });

    const both = await start({ name: "x", autoName: true, inputs: {} });
    expect(both.status).toBe(400);
    expect(both.json.errors[0]).toContain("name or autoName");

    const tooLong = await start({ name: "x".repeat(121), inputs: {} });
    expect(tooLong.status).toBe(400);

    const plain = await start({ inputs: {} });
    expect(plain.json).toMatchObject({ name: null, autoName: false });
  });

  test("cancel: queued runs end immediately, held runs get job.cancel and a server-side fallback", async () => {
    const deps = testDeps();
    const link = connectRunner(deps, "r1", caps());
    const call = client(deps);
    const queued = addRun(deps);
    const running = addRun(deps, { status: "running", runnerId: "r1" });
    const orphan = addRun(deps, { status: "running", runnerId: "gone" });

    expect((await call("POST", `/api/runs/${queued}/cancel`)).json).toEqual({ ok: true });
    expect(deps.runs.get(queued)!.status).toBe("cancelled");
    expect((await call("GET", `/api/runs/${queued}/events`)).json).toMatchObject([{ seq: 1, type: "run.status", payload: { status: "cancelled" } }]);
    expect((await call("POST", `/api/runs/${queued}/cancel`)).status).toBe(409);

    await call("POST", `/api/runs/${orphan}/cancel`);
    expect(deps.runs.get(orphan)!.status).toBe("cancelled");

    jest.useFakeTimers();
    await call("POST", `/api/runs/${running}/cancel`);
    expect(link.of("job.cancel")).toEqual([{ t: "job.cancel", runId: running }]);
    jest.advanceTimersByTime(29_000);
    expect(deps.runs.get(running)!.status).toBe("running");
    jest.advanceTimersByTime(1_001);
    expect(deps.runs.get(running)).toMatchObject({ status: "cancelled", error: "runner did not confirm cancellation" });
  });

  test("permission and elicitation answers are relayed to the runner holding the run", async () => {
    const deps = testDeps();
    const link = connectRunner(deps, "r1", caps());
    const call = client(deps);
    const running = addRun(deps, { status: "running", runnerId: "r1" });
    const orphan = addRun(deps, { status: "running", runnerId: "gone" });

    expect((await call("POST", `/api/runs/${running}/permissions/p1`, { optionId: "allow" })).json).toEqual({ ok: true });
    expect((await call("POST", `/api/runs/${running}/permissions/p2`, { optionId: null })).json).toEqual({ ok: true });
    expect(
      (await call("POST", `/api/runs/${running}/elicitations/e1`, { action: "accept", content: { ok: true } })).json,
    ).toEqual({ ok: true });
    expect(link.sent).toEqual([
      { t: "permission.respond", runId: running, requestId: "p1", optionId: "allow" },
      { t: "permission.respond", runId: running, requestId: "p2", optionId: null },
      { t: "elicitation.respond", runId: running, requestId: "e1", action: "accept", content: { ok: true } },
    ]);
    expect((await call("POST", `/api/runs/${running}/elicitations/e2`, { action: "maybe" })).status).toBe(400);
    expect((await call("POST", `/api/runs/${orphan}/permissions/p1`, { optionId: "allow" })).status).toBe(409);
  });

  test("retry: failed run requeues with the step cursor, resets later steps and keeps prior outputs", async () => {
    const deps = testDeps();
    const other = connectRunner(deps, "r0", caps()); // sorts first: would win if the run were not pinned
    const link = connectRunner(deps, "r1", caps());
    const call = client(deps);
    const def = flowDef({
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "first" },
        { id: "b", name: "B", kind: "prompt", prompt: "second {{steps.a.output}}" },
        { id: "c", name: "C", kind: "prompt", prompt: "third" },
      ],
    });
    const run = addRun(deps, { definition: def, status: "failed", error: "step b failed", runnerId: "r1" });
    deps.db
      .update(schema.runSteps)
      .set({ status: "succeeded", output: "A out", finishedAt: 1 })
      .where(and(eq(schema.runSteps.runId, run), eq(schema.runSteps.stepId, "a")))
      .run();
    deps.db
      .update(schema.runSteps)
      .set({ status: "failed", output: "B out" })
      .where(and(eq(schema.runSteps.runId, run), eq(schema.runSteps.stepId, "b")))
      .run();
    deps.runs.ingest(run, [{ runId: run, seq: 1, ts: 1, type: "run.status", payload: { status: "running" } }]);

    expect((await call("POST", `/api/runs/${run}/retry`, { fromStepId: "nope" })).status).toBe(400);
    expect((await call("POST", `/api/runs/${run}/retry`, { fromStepId: "c" })).status).toBe(409); // b not succeeded
    expect((await call("POST", `/api/runs/${addRun(deps, { status: "succeeded" })}/retry`, {})).status).toBe(409);
    expect((await call("POST", "/api/runs/missing/retry", {})).status).toBe(404);

    expect((await call("POST", `/api/runs/${run}/retry`, {})).json).toEqual({ ok: true });
    // The kick inside the route re-dispatches the run with its resume payload.
    deps.scheduler.kick();
    const row = deps.runs.get(run)!;
    // Resuming a local_path workspace past step 1 pins the run to the runner that ran it.
    expect(row).toMatchObject({ status: "assigned", runnerId: "r1", error: null, finishedAt: null, resumeFrom: 1, resumeRunnerId: "r1" });
    expect(other.of("job.assign")).toEqual([]);
    expect(eventsAfter(deps, run, 1)).toMatchObject([{ type: "run.status", payload: { status: "queued", resumeFromStepId: "b" } }]);
    const steps = deps.db.select().from(schema.runSteps).where(eq(schema.runSteps.runId, run)).all();
    expect(steps.find((s) => s.stepId === "a")).toMatchObject({ status: "succeeded", output: "A out" });
    expect(steps.find((s) => s.stepId === "b")).toMatchObject({ status: "pending", output: null });
    expect(steps.find((s) => s.stepId === "c")).toMatchObject({ status: "pending", output: null });
    // The retry's own `run.status queued` event continues the transcript's seq.
    expect(deps.runs.maxSeq(run)).toBe(2);
    const assign = link.of("job.assign")[0]!.run;
    expect(assign.resume).toEqual({ fromStepIdx: 1, prior: [{ stepId: "a", output: "A out" }] });
    expect(assign.seqFrom).toBe(3);

    // Double retry (the run is assigned again, non-terminal) is 409.
    expect((await call("POST", `/api/runs/${run}/retry`, {})).status).toBe(409);
  });

  test("retry default cursor: first step that did not succeed, else the last step; cancelled runs too", async () => {
    const deps = testDeps();
    const call = client(deps);
    const def = flowDef({
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "first" },
        { id: "b", name: "B", kind: "prompt", prompt: "second" },
      ],
    });
    // Failed before any step ran (e.g. workspace prep): every step is pending.
    const early = addRun(deps, { definition: def, status: "failed" });
    expect((await call("POST", `/api/runs/${early}/retry`, {})).status).toBe(200);
    expect(deps.runs.get(early)).toMatchObject({ status: "queued", resumeFrom: 0, resumeRunnerId: null });

    // Failed after every step succeeded (e.g. the run's own finalisation): the last step reruns.
    const late = addRun(deps, { definition: def, status: "failed" });
    deps.db.update(schema.runSteps).set({ status: "succeeded" }).where(eq(schema.runSteps.runId, late)).run();
    expect((await call("POST", `/api/runs/${late}/retry`, {})).status).toBe(200);
    expect(deps.runs.get(late)).toMatchObject({ status: "queued", resumeFrom: 1 });

    // Cancelled mid-run: the interrupted step reruns, earlier outputs stay.
    const cancelled = addRun(deps, { definition: def, status: "cancelled" });
    deps.db
      .update(schema.runSteps)
      .set({ status: "succeeded", output: "A out" })
      .where(and(eq(schema.runSteps.runId, cancelled), eq(schema.runSteps.stepId, "a")))
      .run();
    deps.db
      .update(schema.runSteps)
      .set({ status: "cancelled" })
      .where(and(eq(schema.runSteps.runId, cancelled), eq(schema.runSteps.stepId, "b")))
      .run();
    expect((await call("POST", `/api/runs/${cancelled}/retry`, {})).status).toBe(200);
    expect(deps.runs.get(cancelled)).toMatchObject({ status: "queued", resumeFrom: 1 });
  });

  test("intervention answers are validated and relayed to the runner holding the run", async () => {
    const deps = testDeps();
    const link = connectRunner(deps, "r1", caps());
    const call = client(deps);
    const definition = flowDef({
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "go" },
        { id: "gate", name: "Gate", kind: "intervention", message: "review it" },
      ],
    });
    const running = addRun(deps, { status: "running", runnerId: "r1", definition });
    const offline = addRun(deps, { status: "running", runnerId: "gone", definition });

    const ok = await call("POST", `/api/runs/${running}/interventions/req1`, {
      stepId: "gate",
      action: "message",
      session: "agent",
      text: "/review the diff",
    });
    expect(ok.json).toEqual({ ok: true });
    expect(link.of("intervention.respond")[0]).toEqual({
      t: "intervention.respond",
      runId: running,
      requestId: "req1",
      action: "message",
      session: "agent",
      text: "/review the diff",
    });

    // message without text or session → 400, nothing relayed
    const blank = await call("POST", `/api/runs/${running}/interventions/req2`, { stepId: "gate", action: "message", session: "agent", text: "  " });
    expect(blank.status).toBe(400);
    expect(blank.json.errors.join()).toContain("write a message");
    expect((await call("POST", `/api/runs/${running}/interventions/req2`, { stepId: "gate", action: "message", text: "hi" })).status).toBe(400);
    expect(link.sent.length).toBe(1);

    // non-intervention stepId → 400
    expect(
      (await call("POST", `/api/runs/${running}/interventions/req3`, { stepId: "impl", action: "continue" })).status,
    ).toBe(400);
    // action cancel relays without steps
    expect(
      (await call("POST", `/api/runs/${running}/interventions/req4`, { stepId: "gate", action: "cancel" })).json,
    ).toEqual({ ok: true });
    expect(link.of("intervention.respond")[1]).toEqual({
      t: "intervention.respond",
      runId: running,
      requestId: "req4",
      action: "cancel",
    });
    // offline runner → 409
    expect((await call("POST", `/api/runs/${offline}/interventions/req5`, { stepId: "gate", action: "continue" })).status).toBe(409);
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("runners API", () => {
  test("fs relay: result, remote error → 400, timeout → 504, offline → 404", async () => {
    const deps = testDeps();
    const link = connectRunner(deps, "r1", caps());
    const call = client(deps);

    const ok = call("GET", "/api/runners/r1/fs?path=/Users/me/Documents");
    const req = link.of("rpc.call")[0]!; // sent synchronously by the route
    expect(req.params).toEqual({ path: "/Users/me/Documents" });
    deps.hub.resolveRpc("r1", req.rpcId, { ok: true, result: { path: "/Users/me/Documents", entries: [] } });
    expect(await ok).toEqual({ status: 200, json: { path: "/Users/me/Documents", entries: [] } });

    const denied = call("GET", "/api/runners/r1/fs?path=/etc");
    deps.hub.resolveRpc("r1", link.of("rpc.call")[1]!.rpcId, { ok: false, error: "Path outside allowedRoots" });
    expect(await denied).toEqual({ status: 400, json: { error: "Path outside allowedRoots" } });

    jest.useFakeTimers();
    connectRunner(deps, "r2", caps()); // never answers
    const slow = call("GET", "/api/runners/r2/fs");
    jest.advanceTimersByTime(FS_LIST_TIMEOUT_MS + 1);
    expect(await slow).toEqual({ status: 504, json: { error: "runner did not answer fs.list within 10s" } });
    jest.useRealTimers();

    expect((await call("GET", "/api/runners/nobody/fs")).status).toBe(404);
    deps.hub.detachRunner("r1", link);
    expect((await call("GET", "/api/runners/r1/fs")).json).toEqual({ error: "Runner offline" });
  });

  test("runner list and catalog only merge online runners", async () => {
    const deps = testDeps();
    connectRunner(
      deps,
      "r1",
      caps({ labels: ["mac"], models: [{ id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }], skills: [{ name: "review", description: "Review code" }] }),
      { labels: ["laptop"] },
    );
    connectRunner(
      deps,
      "r2",
      caps({
        models: [
          { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
          { id: "litellm/glm-5.3", name: "GLM 5.3" },
        ],
        skills: [{ name: "review", description: "other" }, { name: "sec", description: "Security" }],
      }),
    );
    connectRunner(deps, "r3", caps({ commands: [{ name: "stale", description: "" }] }), { lastSeenAt: 0 });
    addRun(deps, { status: "running", runnerId: "r1" });
    const call = client(deps);

    const runners = (await call("GET", "/api/runners")).json;
    expect(runners.map((r: { id: string; online: boolean; runningJobs: number }) => [r.id, r.online, r.runningJobs])).toEqual([
      ["r1", true, 1],
      ["r2", true, 0],
      ["r3", false, 0],
    ]);
    expect(runners[0].labels).toEqual(["laptop", "mac"]);

    const catalog = (await call("GET", "/api/catalog")).json as Catalog;
    expect(catalog).toEqual({
      skills: [
        { name: "review", description: "Review code", runnerIds: ["r1", "r2"] },
        { name: "sec", description: "Security", runnerIds: ["r2"] },
      ],
      commands: [],
      models: [
        { id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        { id: "litellm/glm-5.3", name: "GLM 5.3" },
      ],
    });
  });

  test("unknown API paths are JSON 404s and the SPA hint is served when the UI is not built", async () => {
    const app = createApp(testDeps());
    const api = await app.request("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "Not found" });
    const page = await app.request("/runs/123");
    expect(await page.text()).toContain("Web UI not built");
  });
});
