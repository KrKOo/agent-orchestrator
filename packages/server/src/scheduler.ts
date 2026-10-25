import type { FlowDefinition, RunnerCapabilities } from "@orch/protocol";
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { posix } from "node:path";
import { schema } from "./db";
import { DEFAULT_MAX_CONCURRENT_PER_REPO } from "./config";
import type { RunService } from "./runs";

const { runs, runSteps, runners } = schema;

/** A runner counts as online while connected and seen within this window. */
export const ONLINE_WINDOW_MS = 45_000;
/** Non-terminal runs held by a runner offline for longer than this fail with `runner_lost`. */
export const RUNNER_LOST_MS = 10 * 60_000;
/** Statuses of runs a runner holds (slot taken, resumed on reconnect, failed when the runner is lost). */
export const ACTIVE_STATUSES = ["assigned", "running", "awaiting_input"] as const;

export interface RunnerState {
  id: string;
  ownerUserId: string | null;
  /** Union of server-assigned (token) labels and runner-advertised labels. */
  labels: string[];
  capabilities: RunnerCapabilities | null;
  lastSeenAt: number | null;
  connected: boolean;
  /** The current connection finished replaying its outbox (`replayed`); no jobs before that. */
  replayed: boolean;
  /** Runs currently `assigned`/`running` on this runner. */
  running: number;
}

export interface SchedulableRun {
  trust: "owner" | "untrusted";
  createdBy: string | null;
  definition: FlowDefinition;
}

export function isOnline(r: Pick<RunnerState, "connected" | "lastSeenAt">, now: number): boolean {
  return r.connected && r.lastSeenAt !== null && now - r.lastSeenAt <= ONLINE_WINDOW_MS;
}

/** True when `path` equals `root` or lies below it (lexically, after normalisation). */
export function isUnderRoot(path: string, root: string): boolean {
  const p = posix.normalize(path);
  const r = posix.normalize(root).replace(/\/+$/, "") || "/";
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

export function isEligible(run: SchedulableRun, r: RunnerState, now: number): boolean {
  const caps = r.capabilities;
  if (!caps || !isOnline(r, now) || !r.replayed) return false;
  if (r.running >= caps.maxConcurrentJobs) return false;
  if (!run.definition.runnerLabels.every((l) => r.labels.includes(l))) return false;
  if (run.trust === "owner" ? r.ownerUserId !== run.createdBy : !caps.acceptUntrusted) return false;
  const ws = run.definition.workspace;
  if (ws.kind === "local_path" && !caps.allowedRoots.some((root) => isUnderRoot(ws.path, root))) return false;
  return true;
}

export interface SchedulerOptions {
  /** Non-terminal pull request runs (webhook or manual) assigned at once per repository. */
  maxConcurrentPerRepo: number;
}

export class Scheduler {
  private readonly startedAt: number;
  private timer: Timer | null = null;
  private kicking = false;

  constructor(
    private readonly runService: RunService,
    private readonly now: () => number = Date.now,
    private readonly opts: SchedulerOptions = { maxConcurrentPerRepo: DEFAULT_MAX_CONCURRENT_PER_REPO },
  ) {
    this.startedAt = now();
  }

  start(intervalMs = 5000): void {
    this.timer ??= setInterval(() => this.kick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  runnerStates(): RunnerState[] {
    const { db, hub } = this.runService;
    const counts = new Map(
      db
        .select({ runnerId: runs.runnerId, n: sql<number>`count(*)` })
        .from(runs)
        .where(and(isNotNull(runs.runnerId), inArray(runs.status, [...ACTIVE_STATUSES])))
        .groupBy(runs.runnerId)
        .all()
        .map((c) => [c.runnerId!, c.n]),
    );
    return db
      .select()
      .from(runners)
      .orderBy(asc(runners.id))
      .all()
      .map((r) => ({
        id: r.id,
        ownerUserId: r.ownerUserId,
        labels: [...new Set([...r.labels, ...(r.capabilities?.labels ?? [])])],
        capabilities: r.capabilities,
        lastSeenAt: r.lastSeenAt,
        connected: hub.isConnected(r.id),
        replayed: hub.isReplayed(r.id),
        running: counts.get(r.id) ?? 0,
      }));
  }

  /** Fails lost runners' runs (held or pinned), then assigns queued runs (oldest first) to the least-loaded eligible runner. */
  kick(): void {
    if (this.kicking) return;
    this.kicking = true;
    try {
      const now = this.now();
      const states = this.runnerStates();
      this.failLostRuns(states, now);
      this.assignQueued(states, now);
    } catch (err) {
      console.error("[scheduler] kick failed:", err);
    } finally {
      this.kicking = false;
    }
  }

  /** Unknown, or offline for longer than `RUNNER_LOST_MS`; downtime of the server itself does not count. */
  private isLost(r: RunnerState | undefined, now: number): boolean {
    if (r && isOnline(r, now)) return false;
    return now - Math.max(r?.lastSeenAt ?? 0, this.startedAt) > RUNNER_LOST_MS;
  }

  private failLostRuns(states: RunnerState[], now: number): void {
    const { db } = this.runService;
    const byId = new Map(states.map((s) => [s.id, s]));
    const held = db
      .select({ id: runs.id, runnerId: runs.runnerId })
      .from(runs)
      .where(and(isNotNull(runs.runnerId), inArray(runs.status, [...ACTIVE_STATUSES])))
      .all();
    for (const run of held) {
      const r = byId.get(run.runnerId!);
      if (!this.isLost(r, now)) continue;
      console.warn(`[scheduler] run ${run.id}: runner ${run.runnerId} lost`);
      this.runService.terminate(run.id, "failed", "runner_lost");
      if (r) r.running = Math.max(0, r.running - 1);
    }
    // A retry pinned to the runner holding its worktree cannot run elsewhere; retrying from step 1 unpins it.
    const pinned = db
      .select({ id: runs.id, resumeRunnerId: runs.resumeRunnerId })
      .from(runs)
      .where(and(isNotNull(runs.resumeRunnerId), eq(runs.status, "queued")))
      .all();
    for (const run of pinned) {
      if (!this.isLost(byId.get(run.resumeRunnerId!), now)) continue;
      console.warn(`[scheduler] run ${run.id}: resume runner ${run.resumeRunnerId} lost`);
      this.runService.terminate(run.id, "failed", "resume_runner_lost");
    }
  }

  private assignQueued(states: RunnerState[], now: number): void {
    const { db, hub } = this.runService;
    const queued = db.select().from(runs).where(eq(runs.status, "queued")).orderBy(asc(runs.createdAt), asc(runs.id)).all();
    if (queued.length === 0) return;
    const perRepo = new Map<string, number>();
    for (const r of db
      .select({ github: runs.github })
      .from(runs)
      .where(and(isNotNull(runs.github), inArray(runs.status, [...ACTIVE_STATUSES])))
      .all()) {
      if (r.github) perRepo.set(r.github.repo, (perRepo.get(r.github.repo) ?? 0) + 1);
    }
    for (const run of queued) {
      const repo = run.github?.repo;
      if (repo !== undefined && (perRepo.get(repo) ?? 0) >= this.opts.maxConcurrentPerRepo) continue;
      const target = states
        .filter((r) => (run.resumeRunnerId === null || r.id === run.resumeRunnerId) && isEligible(run, r, now))
        .sort((a, b) => a.running - b.running || a.id.localeCompare(b.id))[0];
      if (!target) continue;
      const claimed = db
        .update(runs)
        .set({ status: "assigned", runnerId: target.id })
        .where(and(eq(runs.id, run.id), eq(runs.status, "queued")))
        .returning({ id: runs.id })
        .all();
      if (claimed.length === 0) continue;
      const gh = run.github;
      // Retried runs carry the step cursor plus prior succeeded outputs; `seqFrom` continues the
      // transcript's seq numbering even when a different runner resumes (its outbox restarts at 1).
      const prior =
        run.resumeFrom !== null
          ? db
              .select({ stepId: runSteps.stepId, output: runSteps.output, structured: runSteps.structured })
              .from(runSteps)
              .where(and(eq(runSteps.runId, run.id), lt(runSteps.idx, run.resumeFrom), eq(runSteps.status, "succeeded")))
              .orderBy(asc(runSteps.idx))
              .all()
              .map((s) => ({ stepId: s.stepId, output: s.output ?? "", ...(s.structured === null ? {} : { structured: s.structured }) }))
          : undefined;
      const sent = hub.sendToRunner(target.id, {
        t: "job.assign",
        run: {
          runId: run.id,
          trust: run.trust,
          definition: run.definition,
          inputs: run.inputs,
          ...(gh ? { github: { repo: gh.repo, number: gh.number, headSha: gh.headSha, baseSha: gh.baseSha } } : {}),
          ...(prior !== undefined ? { resume: { fromStepIdx: run.resumeFrom!, prior } } : {}),
          ...(prior !== undefined ? { seqFrom: this.runService.maxSeq(run.id) + 1 } : {}),
        },
      });
      if (!sent) {
        db.update(runs).set({ status: "queued", runnerId: null }).where(eq(runs.id, run.id)).run();
        target.connected = false;
        continue;
      }
      target.running++;
      if (repo !== undefined) perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
      console.log(`[scheduler] run ${run.id} assigned to runner ${target.id}`);
    }
  }
}
