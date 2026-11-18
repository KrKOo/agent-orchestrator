import { afterEach, describe, expect, jest, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { type Catalog, type FlowRow, type RunDetail, type RunRow, RUNS_PAGE_SIZE, runsCursor } from "@orch/protocol";
import { FS_LIST_TIMEOUT_MS, registerRunner } from "../src/api/runners";
import { createApp } from "../src/app";
import { schema } from "../src/db";
import type { AppDeps } from "../src/deps";
import { PatCredentials } from "../src/github/credentials";
import { eventsAfter } from "../src/ws/browser";
import { authenticateRunner } from "../src/ws/runner";
import { addRun, caps, connectRunner, FakeLink, flowDef, testDeps } from "./helpers";

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

  test("run list filters by status and name/id substring, and rejects unknown statuses", async () => {
    const deps = testDeps();
    const call = client(deps);
    const asking = addRun(deps, { status: "awaiting_input", name: "Fix 100% CPU", createdAt: 3 });
    const approval = addRun(deps, { status: "awaiting_approval", createdAt: 2 });
    addRun(deps, { status: "failed", name: "Other", createdAt: 1 });
    const accented = addRun(deps, { status: "failed", name: "Échec du build", createdAt: 0 });
    const ids = async (query: string) => (await call("GET", `/api/runs?${query}`)).json.map((r: RunRow) => r.id);

    expect(await ids("status=awaiting_input,awaiting_approval")).toEqual([asking, approval]);
    expect(await ids("status=")).toHaveLength(4);
    expect(await ids("q=100%25")).toEqual([asking]); // `%` matches literally, not as a LIKE wildcard
    expect(await ids("q=fix%20100")).toEqual([asking]); // case-insensitive
    expect(await ids(`q=${approval.slice(-6).toLowerCase()}`)).toEqual([approval]);
    expect(await ids(`q=${encodeURIComponent("Échec")}`)).toEqual([accented]); // non-ASCII text matches itself
    expect(await ids("status=failed&q=fix")).toEqual([]);

    const bad = await call("GET", "/api/runs?status=running,bogus");
    expect(bad.status).toBe(400);
    expect(bad.json.errors[0]).toStartWith("status.1:");
    expect((await call("GET", "/api/runs?before=nope")).status).toBe(400);
  });

  test("run list pages with a before cursor across rows sharing createdAt", async () => {
    const deps = testDeps();
    const call = client(deps);
    // All rows share one createdAt, so only the id tiebreak orders them; a createdAt-only cursor would loop or skip.
    const total = RUNS_PAGE_SIZE + 5;
    for (let i = 0; i < total; i++) addRun(deps, { createdAt: 1000 });
    addRun(deps, { createdAt: 999 });

    const first = (await call("GET", "/api/runs")).json as RunRow[];
    expect(first).toHaveLength(RUNS_PAGE_SIZE);
    const second = (await call("GET", `/api/runs?before=${runsCursor(first.at(-1)!)}`)).json as RunRow[];
    expect(second).toHaveLength(6);
    expect(second.at(-1)!.createdAt).toBe(999);
    const all = [...first, ...second].map((r) => r.id);
    expect(new Set(all).size).toBe(total + 1);
    expect((await call("GET", `/api/runs?before=${runsCursor(second.at(-1)!)}`)).json).toEqual([]);
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

    // A skipped body step (loop stop ended the iteration) counts as done for the cursor.
    const skipped = addRun(deps, { definition: def, status: "failed" });
    deps.db.update(schema.runSteps).set({ status: "skipped", output: "" }).where(eq(schema.runSteps.runId, skipped)).run();
    expect((await call("POST", `/api/runs/${skipped}/retry`, {})).status).toBe(200);
    expect(deps.runs.get(skipped)).toMatchObject({ status: "queued", resumeFrom: 1 });

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

  test("run from here inside a branch the run skipped: only the branch's first step", async () => {
    const deps = testDeps();
    const call = client(deps);
    const definition = flowDef({
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "a" },
        { id: "pick", name: "Pick", kind: "condition", ref: "steps.a.output", op: "truthy", thenEnd: "t2", elseEnd: "e1" },
        { id: "t1", name: "T1", kind: "prompt", prompt: "t1" },
        { id: "t2", name: "T2", kind: "prompt", prompt: "{{steps.t1.output}}" },
        { id: "e1", name: "E1", kind: "prompt", prompt: "e1" },
      ],
    });
    const run = addRun(deps, { definition, status: "failed" });
    const set = (stepId: string, fields: Partial<typeof schema.runSteps.$inferInsert>) =>
      deps.db.update(schema.runSteps).set(fields).where(and(eq(schema.runSteps.runId, run), eq(schema.runSteps.stepId, stepId))).run();
    // The condition took else: the then-block was skipped, the else step failed.
    set("a", { status: "succeeded", output: "" });
    set("pick", { status: "succeeded", output: "", structured: { branch: "else" } });
    set("t1", { status: "skipped" });
    set("t2", { status: "skipped" });
    set("e1", { status: "failed" });

    const mid = await call("POST", `/api/runs/${run}/retry`, { fromStepId: "t2" });
    expect(mid.status).toBe(409);
    expect(mid.json.error).toContain("branch the run did not take");
    // The taken branch can be resumed anywhere; the skipped one from its first step.
    expect((await call("POST", `/api/runs/${run}/retry`, { fromStepId: "t1" })).status).toBe(200);
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

    // An ask-loop gate accepts the same answers, plus `repeat` which is forwarded to the runner link.
    const loopDef = flowDef({
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "go" },
        { id: "again", name: "Repeat", kind: "loop", to: "a", maxIterations: 3, stop: { when: "ask" } },
      ],
    });
    const looping = addRun(deps, { status: "running", runnerId: "r1", definition: loopDef });

    const repeat = await call("POST", `/api/runs/${looping}/interventions/req6`, { stepId: "again", action: "repeat" });
    expect(repeat.json).toEqual({ ok: true });
    expect(link.of("intervention.respond").at(-1)).toEqual({
      t: "intervention.respond",
      runId: looping,
      requestId: "req6",
      action: "repeat",
    });

    // `repeat` on a plain intervention step is rejected with 400 and not relayed.
    const plain = await call("POST", `/api/runs/${running}/interventions/req7`, { stepId: "gate", action: "repeat" });
    expect(plain.status).toBe(400);
    // Still only the earlier message + cancel + ask-loop repeat answers; the rejected one was not relayed.
    expect(link.of("intervention.respond")).toHaveLength(3);

    // A non-ask loop step is not an intervention gate.
    const maxLoop = flowDef({
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "go" },
        { id: "spin", name: "Spin", kind: "loop", to: "a", maxIterations: 3 },
      ],
    });
    const maxing = addRun(deps, { status: "running", runnerId: "r1", definition: maxLoop });
    expect(
      (await call("POST", `/api/runs/${maxing}/interventions/req8`, { stepId: "spin", action: "continue" })).status,
    ).toBe(400);
  });

  test("a gate with choices needs a valid choice on continue, and only there", async () => {
    const deps = testDeps();
    const link = connectRunner(deps, "r1", caps());
    const call = client(deps);
    const definition = flowDef({
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "go" },
        { id: "gate", name: "Gate", kind: "intervention", choices: [{ id: "approve", label: "Approve" }, { id: "fix", label: "Fix" }] },
        { id: "plain", name: "Plain", kind: "intervention" },
      ],
    });
    const running = addRun(deps, { status: "running", runnerId: "r1", definition });
    const post = (body: Record<string, unknown>) => call("POST", `/api/runs/${running}/interventions/req`, body);

    const missing = await post({ stepId: "gate", action: "continue" });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toBe(`Step "gate" requires a choice (approve, fix)`);
    expect((await post({ stepId: "gate", action: "continue", choice: "redo" })).status).toBe(400);
    expect((await post({ stepId: "plain", action: "continue", choice: "fix" })).status).toBe(400);
    expect((await post({ stepId: "gate", action: "message", session: "agent", text: "why?", choice: "fix" })).status).toBe(400);
    expect(link.of("intervention.respond")).toHaveLength(0);

    // Chat and cancel need no choice; a valid pick is forwarded.
    expect((await post({ stepId: "gate", action: "message", session: "agent", text: "why?" })).json).toEqual({ ok: true });
    expect((await post({ stepId: "gate", action: "continue", choice: "fix" })).json).toEqual({ ok: true });
    expect(link.of("intervention.respond").at(-1)).toEqual({ t: "intervention.respond", runId: running, requestId: "req", action: "continue", choice: "fix" });
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

  test("DELETE of an unknown runner is a 404", async () => {
    expect(await client(testDeps())("DELETE", "/api/runners/nobody")).toEqual({ status: 404, json: { error: "Runner not found" } });
  });

  test("DELETE revokes the token, cancels and fails held runs, fails pinned retries and closes the link", async () => {
    const deps = testDeps();
    const { runnerId, token } = registerRunner(deps.db, { name: "laptop", labels: [], ownerUserId: null });
    const link = new FakeLink();
    deps.hub.attachRunner(runnerId, link);
    deps.hub.setReplayed(link, true);
    const held = addRun(deps, { status: "running", runnerId });
    const pinned = addRun(deps, { status: "queued", resumeRunnerId: runnerId });
    const call = client(deps);

    expect((await call("DELETE", `/api/runners/${runnerId}`)).status).toBe(204);

    expect(link.of("job.cancel")).toEqual([{ t: "job.cancel", runId: held }]);
    expect(link.closed).toEqual({ code: 4401, reason: "runner deleted" });
    expect(deps.hub.isConnected(runnerId)).toBe(false);
    expect(deps.runs.get(held)).toMatchObject({ status: "failed", error: "runner_deleted" });
    expect(deps.runs.get(pinned)).toMatchObject({ status: "failed", error: "resume_runner_deleted" });
    expect((await call("GET", "/api/runners")).json).toEqual([]);
    expect(authenticateRunner(deps, `Bearer ${token}`)).toBeNull();
  });

  test("DELETE fails a pending fs RPC as offline", async () => {
    const deps = testDeps();
    connectRunner(deps, "r1", caps());
    const call = client(deps);
    const pending = call("GET", "/api/runners/r1/fs?path=/Users/me/Documents");
    expect((await call("DELETE", "/api/runners/r1")).status).toBe(204);
    expect(await pending).toEqual({ status: 404, json: { error: "Runner offline" } });
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
