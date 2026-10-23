import type { FlowDefinition, RunnerCapabilities } from "@orch/protocol";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { posix } from "node:path";
import { schema } from "./db";
import type { RunService } from "./runs";

const { runs, runners } = schema;

/** A runner counts as online while connected and seen within this window. */
export const ONLINE_WINDOW_MS = 45_000;
/** Non-terminal runs held by a runner offline for longer than this fail with `runner_lost`. */
export const RUNNER_LOST_MS = 10 * 60_000;
export const ACTIVE_STATUSES = ["assigned", "running"] as const;

export interface RunnerState {
  id: string;
  ownerUserId: string | null;
  /** Union of server-assigned (token) labels and runner-advertised labels. */
  labels: string[];
  capabilities: RunnerCapabilities | null;
  lastSeenAt: number | null;
  connected: boolean;
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
  if (!caps || !isOnline(r, now)) return false;
  if (r.running >= caps.maxConcurrentJobs) return false;
  if (!run.definition.runnerLabels.every((l) => r.labels.includes(l))) return false;
  if (run.trust === "owner" ? r.ownerUserId !== run.createdBy : !caps.acceptUntrusted) return false;
  const ws = run.definition.workspace;
  if (ws.kind === "local_path" && !caps.allowedRoots.some((root) => isUnderRoot(ws.path, root))) return false;
  return true;
}

export class Scheduler {
  private readonly startedAt: number;
  private timer: Timer | null = null;
  private kicking = false;

  constructor(
    private readonly runService: RunService,
    private readonly now: () => number = Date.now,
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
        running: counts.get(r.id) ?? 0,
      }));
  }

  /** Fails lost runners' runs, then assigns queued runs (oldest first) to the least-loaded eligible runner. */
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
      if (r && isOnline(r, now)) continue;
      // Downtime of the server itself does not count against the runner.
      const offlineSince = Math.max(r?.lastSeenAt ?? 0, this.startedAt);
      if (now - offlineSince <= RUNNER_LOST_MS) continue;
      console.warn(`[scheduler] run ${run.id}: runner ${run.runnerId} lost`);
      this.runService.terminate(run.id, "failed", "runner_lost");
      if (r) r.running = Math.max(0, r.running - 1);
    }
  }

  private assignQueued(states: RunnerState[], now: number): void {
    const { db, hub } = this.runService;
    const queued = db.select().from(runs).where(eq(runs.status, "queued")).orderBy(asc(runs.createdAt), asc(runs.id)).all();
    for (const run of queued) {
      const target = states
        .filter((r) => isEligible(run, r, now))
        .sort((a, b) => a.running - b.running || a.id.localeCompare(b.id))[0];
      if (!target) continue;
      const claimed = db
        .update(runs)
        .set({ status: "assigned", runnerId: target.id })
        .where(and(eq(runs.id, run.id), eq(runs.status, "queued")))
        .returning({ id: runs.id })
        .all();
      if (claimed.length === 0) continue;
      const sent = hub.sendToRunner(target.id, {
        t: "job.assign",
        run: { runId: run.id, trust: run.trust, definition: run.definition, inputs: run.inputs },
      });
      if (!sent) {
        db.update(runs).set({ status: "queued", runnerId: null }).where(eq(runs.id, run.id)).run();
        target.connected = false;
        continue;
      }
      target.running++;
      console.log(`[scheduler] run ${run.id} assigned to runner ${target.id}`);
    }
  }
}
