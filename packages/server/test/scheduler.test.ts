import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { isEligible, isUnderRoot, RUNNER_LOST_MS, Scheduler, type RunnerState } from "../src/scheduler";
import { schema } from "../src/db";
import { addRun, addRunner, caps, connectRunner, flowDef, testDeps } from "./helpers";

const NOW = 1_000_000_000;

function runner(over: Partial<RunnerState> = {}): RunnerState {
  return {
    id: "r1",
    ownerUserId: null,
    labels: [],
    capabilities: caps(),
    lastSeenAt: NOW - 1000,
    connected: true,
    replayed: true,
    running: 0,
    ...over,
  };
}

const ownerRun = { trust: "owner" as const, createdBy: null, definition: flowDef() };

describe("isEligible", () => {
  test("baseline runner is eligible", () => {
    expect(isEligible(ownerRun, runner(), NOW)).toBe(true);
  });

  test("offline: disconnected, stale heartbeat, or never sent hello", () => {
    expect(isEligible(ownerRun, runner({ connected: false }), NOW)).toBe(false);
    expect(isEligible(ownerRun, runner({ lastSeenAt: NOW - 46_000 }), NOW)).toBe(false);
    expect(isEligible(ownerRun, runner({ capabilities: null }), NOW)).toBe(false);
  });

  test("a connection that has not finished its outbox replay gets no jobs", () => {
    expect(isEligible(ownerRun, runner({ replayed: false }), NOW)).toBe(false);
  });

  test("labels must be a superset of runnerLabels", () => {
    const run = { ...ownerRun, definition: flowDef({ runnerLabels: ["gpu", "mac"] }) };
    expect(isEligible(run, runner({ labels: ["gpu"] }), NOW)).toBe(false);
    expect(isEligible(run, runner({ labels: ["mac", "gpu", "extra"] }), NOW)).toBe(true);
  });

  test("workspace path must lie under an allowed root", () => {
    const at = (path: string) => ({ ...ownerRun, definition: flowDef({ workspace: { kind: "local_path", path } }) });
    expect(isEligible(at("/Users/me/Documents"), runner(), NOW)).toBe(true);
    expect(isEligible(at("/Users/me/Documents/a/b"), runner(), NOW)).toBe(true);
    expect(isEligible(at("/Users/me/Documents2/repo"), runner(), NOW)).toBe(false);
    expect(isEligible(at("/Users/me/Documents/../secret"), runner(), NOW)).toBe(false);
    expect(isEligible(at("/Users/me/Documents/repo"), runner({ capabilities: caps({ allowedRoots: [] }) }), NOW)).toBe(false);
  });

  test("isUnderRoot handles trailing slashes and the filesystem root", () => {
    expect(isUnderRoot("/a/b", "/a/")).toBe(true);
    expect(isUnderRoot("/ab", "/a")).toBe(false);
    expect(isUnderRoot("/anything", "/")).toBe(true);
  });

  test("running jobs must stay below maxConcurrentJobs", () => {
    expect(isEligible(ownerRun, runner({ running: 1, capabilities: caps({ maxConcurrentJobs: 2 }) }), NOW)).toBe(true);
    expect(isEligible(ownerRun, runner({ running: 2, capabilities: caps({ maxConcurrentJobs: 2 }) }), NOW)).toBe(false);
  });

  test("owner runs need a matching runner owner", () => {
    expect(isEligible({ ...ownerRun, createdBy: "u1" }, runner({ ownerUserId: "u1" }), NOW)).toBe(true);
    expect(isEligible({ ...ownerRun, createdBy: "u1" }, runner({ ownerUserId: "u2" }), NOW)).toBe(false);
    expect(isEligible({ ...ownerRun, createdBy: null }, runner({ ownerUserId: "u2" }), NOW)).toBe(false);
  });

  test("untrusted runs need acceptUntrusted", () => {
    const run = { ...ownerRun, trust: "untrusted" as const };
    expect(isEligible(run, runner(), NOW)).toBe(false);
    expect(isEligible(run, runner({ capabilities: caps({ acceptUntrusted: true }) }), NOW)).toBe(true);
  });
});

describe("Scheduler.kick", () => {
  test("assigns oldest queued runs to the least-loaded eligible runner and respects capacity", () => {
    const deps = testDeps();
    const a = connectRunner(deps, "ra", caps({ maxConcurrentJobs: 1 }));
    const b = connectRunner(deps, "rb", caps({ maxConcurrentJobs: 1 }));
    const r1 = addRun(deps, { createdAt: 1 });
    const r2 = addRun(deps, { createdAt: 2 });
    const r3 = addRun(deps, { createdAt: 3 });

    deps.scheduler.kick();

    const status = (id: string) => deps.runs.get(id)!;
    expect(status(r1)).toMatchObject({ status: "assigned", runnerId: "ra" });
    expect(status(r2)).toMatchObject({ status: "assigned", runnerId: "rb" });
    expect(status(r3)).toMatchObject({ status: "queued", runnerId: null });
    expect(a.of("job.assign").map((m) => m.run.runId)).toEqual([r1]);
    expect(b.of("job.assign").map((m) => m.run.runId)).toEqual([r2]);
    expect(a.of("job.assign")[0]!.run).toMatchObject({ trust: "owner", definition: { name: "test flow" } });
    // Fresh runs carry neither resume payload.
    expect(a.of("job.assign")[0]!.run.resume).toBeUndefined();
    expect(a.of("job.assign")[0]!.run.seqFrom).toBeUndefined();

    // Finishing r1 frees ra; the next kick assigns r3 there.
    deps.runs.finish(r1, "succeeded");
    deps.scheduler.kick();
    expect(status(r3)).toMatchObject({ status: "assigned", runnerId: "ra" });
  });

  test("a retried run is assigned with resume.prior from run_steps and a continuing seqFrom", () => {
    const deps = testDeps();
    const link = connectRunner(deps, "r1", caps());
    const def = flowDef({
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "first" },
        { id: "b", name: "B", kind: "prompt", prompt: "second" },
      ],
    });
    const run = addRun(deps, { definition: def, status: "failed" });
    deps.db
      .update(schema.runSteps)
      .set({ status: "succeeded", output: "A out", structured: { n: 1 } })
      .where(and(eq(schema.runSteps.runId, run), eq(schema.runSteps.stepId, "a")))
      .run();
    deps.runs.retry(run, 1); // appends `run.status queued` at seq 1

    deps.scheduler.kick();

    const assigned = link.of("job.assign")[0]!.run;
    expect(assigned.resume).toEqual({ fromStepIdx: 1, prior: [{ stepId: "a", output: "A out", structured: { n: 1 } }] });
    expect(assigned.seqFrom).toBe(2); // maxSeq (the queued event) + 1
    expect(deps.runs.get(run)).toMatchObject({ status: "assigned", resumeFrom: 1 });
  });

  test("a local_path retry past step 1 is pinned to the previous runner; from step 1 it is not", () => {
    const deps = testDeps();
    const other = connectRunner(deps, "r0", caps()); // sorts first, so it wins any unpinned tie
    const prev = connectRunner(deps, "r1", caps());
    const def = flowDef({
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "first" },
        { id: "b", name: "B", kind: "prompt", prompt: "second" },
      ],
    });
    const pinned = addRun(deps, { definition: def, status: "failed", runnerId: "r1" });
    deps.db
      .update(schema.runSteps)
      .set({ status: "succeeded", output: "A out" })
      .where(and(eq(schema.runSteps.runId, pinned), eq(schema.runSteps.stepId, "a")))
      .run();
    const fresh = addRun(deps, { definition: def, status: "failed", runnerId: "r1" });
    deps.runs.retry(pinned, 1);
    deps.runs.retry(fresh, 0);
    expect(deps.runs.get(pinned)).toMatchObject({ resumeRunnerId: "r1" });
    expect(deps.runs.get(fresh)).toMatchObject({ resumeRunnerId: null });

    deps.hub.detachRunner("r1", prev);
    deps.scheduler.kick();
    expect(deps.runs.get(pinned)!.status).toBe("queued"); // r0 is eligible but not the pinned runner
    expect(deps.runs.get(fresh)).toMatchObject({ status: "assigned", runnerId: "r0" });
    expect(other.of("job.assign").map((m) => m.run.runId)).toEqual([fresh]);

    deps.hub.attachRunner("r1", prev);
    deps.hub.setReplayed(prev, true);
    deps.scheduler.kick();
    expect(deps.runs.get(pinned)).toMatchObject({ status: "assigned", runnerId: "r1" });
    expect(prev.of("job.assign").map((m) => m.run.runId)).toEqual([pinned]);
  });

  test("a queued run pinned to a runner unknown or offline for more than 10 minutes fails resume_runner_lost", () => {
    const deps = testDeps();
    const start = Date.now();
    let now = start;
    const scheduler = new Scheduler(deps.runs, () => now);
    addRunner(deps, "r1", { capabilities: caps(), lastSeenAt: start }); // registered, not connected
    const pinned = addRun(deps, { resumeFrom: 1, resumeRunnerId: "r1" });
    const orphan = addRun(deps, { resumeFrom: 1, resumeRunnerId: "deleted" });

    now = start + RUNNER_LOST_MS - 1000;
    scheduler.kick();
    expect(deps.runs.get(pinned)!.status).toBe("queued");
    expect(deps.runs.get(orphan)!.status).toBe("queued");

    now = start + RUNNER_LOST_MS + 1000;
    scheduler.kick();
    for (const id of [pinned, orphan]) {
      // The terminal transition also clears the resume cursor and the pin.
      expect(deps.runs.get(id)).toMatchObject({ status: "failed", error: "resume_runner_lost", resumeFrom: null, resumeRunnerId: null });
    }
  });

  test("leaves runs queued when only ineligible runners are online", () => {
    const deps = testDeps();
    const link = connectRunner(deps, "r1", caps({ labels: ["linux"] }));
    connectRunner(deps, "r2", caps(), { lastSeenAt: Date.now() - 60_000 });
    const run = addRun(deps, { definition: flowDef({ runnerLabels: ["mac"] }) });
    deps.scheduler.kick();
    expect(deps.runs.get(run)!.status).toBe("queued");
    expect(link.sent).toEqual([]);
  });

  test("owner isolation: runs go only to the creator's runners; untrusted runs only to acceptUntrusted runners", () => {
    const deps = testDeps();
    const mine = connectRunner(deps, "r-alice", caps(), { ownerUserId: "alice" });
    const theirs = connectRunner(deps, "r-bob", caps(), { ownerUserId: "bob" });
    const aliceRun = addRun(deps, { createdBy: "alice", createdAt: 1 });
    const carolRun = addRun(deps, { createdBy: "carol", createdAt: 2 });
    const untrusted = addRun(deps, {
      trust: "untrusted",
      createdAt: 3,
      definition: flowDef({ workspace: { kind: "local_path", path: "/Users/me/Documents/repo" } }),
    });
    deps.scheduler.kick();
    expect(deps.runs.get(aliceRun)).toMatchObject({ status: "assigned", runnerId: "r-alice" });
    expect(deps.runs.get(carolRun)!.status).toBe("queued");
    expect(deps.runs.get(untrusted)!.status).toBe("queued");
    expect(mine.of("job.assign").map((m) => m.run.runId)).toEqual([aliceRun]);
    expect(theirs.sent).toEqual([]);

    connectRunner(deps, "r-ci", caps({ acceptUntrusted: true }));
    deps.scheduler.kick();
    expect(deps.runs.get(untrusted)).toMatchObject({ status: "assigned", runnerId: "r-ci" });
    expect(deps.runs.get(carolRun)!.status).toBe("queued");
  });

  test("fails runs held by a runner offline for more than 10 minutes", () => {
    const deps = testDeps();
    const start = Date.now();
    let now = start;
    const scheduler = new Scheduler(deps.runs, () => now);
    addRunner(deps, "r1", { capabilities: caps(), lastSeenAt: start }); // registered, not connected
    const run = addRun(deps, { status: "running", runnerId: "r1" });

    now = start + RUNNER_LOST_MS - 1000;
    scheduler.kick();
    expect(deps.runs.get(run)!.status).toBe("running");

    now = start + RUNNER_LOST_MS + 1000;
    scheduler.kick();
    const lost = deps.runs.get(run)!;
    expect(lost).toMatchObject({ status: "failed", error: "runner_lost" });
    expect(lost.finishedAt).not.toBeNull();
    // The failure is also visible to browsers as a persisted run.status event.
    expect(deps.runs.maxSeq(run)).toBe(1);
  });

  test("a run awaiting input keeps its runner slot and fails with a lost runner like a running one", () => {
    const deps = testDeps();
    connectRunner(deps, "r1", caps({ maxConcurrentJobs: 1 }));
    addRun(deps, { status: "awaiting_input", runnerId: "r1", createdAt: 1 });
    const queued = addRun(deps, { createdAt: 2 });
    deps.scheduler.kick();
    expect(deps.runs.get(queued)!.status).toBe("queued");

    const start = Date.now();
    let now = start;
    const scheduler = new Scheduler(deps.runs, () => now);
    addRunner(deps, "r2", { capabilities: caps(), lastSeenAt: start }); // registered, not connected
    const waiting = addRun(deps, { status: "awaiting_input", runnerId: "r2" });
    now = start + RUNNER_LOST_MS + 1000;
    scheduler.kick();
    expect(deps.runs.get(waiting)).toMatchObject({ status: "failed", error: "runner_lost" });
  });

  test("a connected runner with a fresh heartbeat never loses its runs", () => {
    const deps = testDeps();
    const start = Date.now();
    connectRunner(deps, "r1", caps(), { lastSeenAt: start + 2 * RUNNER_LOST_MS });
    const run = addRun(deps, { status: "running", runnerId: "r1" });
    new Scheduler(deps.runs, () => start + 2 * RUNNER_LOST_MS).kick();
    expect(deps.runs.get(run)!.status).toBe("running");
  });

  test("server downtime does not count toward the lost-runner window", () => {
    const deps = testDeps();
    const now = Date.now();
    addRunner(deps, "r1", { capabilities: caps(), lastSeenAt: now - 3 * RUNNER_LOST_MS });
    const run = addRun(deps, { status: "assigned", runnerId: "r1" });
    new Scheduler(deps.runs, () => now).kick();
    expect(deps.runs.get(run)!.status).toBe("assigned");
  });
});
