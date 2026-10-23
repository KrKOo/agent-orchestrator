import { describe, expect, test } from "bun:test";
import { isEligible, isUnderRoot, RUNNER_LOST_MS, Scheduler, type RunnerState } from "../src/scheduler";
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

    // Finishing r1 frees ra; the next kick assigns r3 there.
    deps.runs.finish(r1, "succeeded");
    deps.scheduler.kick();
    expect(status(r3)).toMatchObject({ status: "assigned", runnerId: "ra" });
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
