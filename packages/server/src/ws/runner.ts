import {
  RunnerMessage,
  type RpcResult,
  type RunnerRpcCall,
  type ServerMessage,
} from "@orch/protocol";
import { and, eq, inArray, max } from "drizzle-orm";
import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { createHash } from "node:crypto";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import type { RunnerLink } from "../hub";
import { isTerminal } from "../runs";
import { ACTIVE_STATUSES } from "../scheduler";

const { runners, runs, runEvents } = schema;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Resolves `Authorization: Bearer <token>` to a registered runner id. */
export function authenticateRunner(deps: Pick<AppDeps, "db">, authorization: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!m) return null;
  const row = deps.db.select({ id: runners.id }).from(runners).where(eq(runners.tokenHash, hashToken(m[1]!))).get();
  return row?.id ?? null;
}

/**
 * Answers a runner-initiated RPC. GitHub methods are allowed only for the runner holding a
 * non-terminal owner-trust run; everything else gets `forbidden`.
 */
export async function handleRunnerRpc(deps: AppDeps, runnerId: string, call: RunnerRpcCall): Promise<RpcResult> {
  const { rpcId } = call;
  const run = deps.runs.get(call.params.runId);
  if (!run || run.runnerId !== runnerId || run.trust !== "owner" || isTerminal(run.status)) {
    return { t: "rpc.result", rpcId, ok: false, error: "forbidden" };
  }
  try {
    switch (call.method) {
      case "github.token": {
        const token = await deps.credentials.tokenFor(call.params.repo, call.params.access);
        return { t: "rpc.result", rpcId, ok: true, result: { token } };
      }
      case "github.createPullRequest": {
        const { repo, head, base, title, body, draft } = call.params;
        const token = await deps.credentials.tokenFor(repo, "write");
        const result = await deps.github.createPullRequest(token, { repo, head, base, title, body, draft });
        return { t: "rpc.result", rpcId, ok: true, result };
      }
    }
  } catch (err) {
    return { t: "rpc.result", rpcId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** One authenticated runner connection. Transport-agnostic so tests can drive it directly. */
export class RunnerSession {
  private attached = false;

  constructor(
    private readonly deps: AppDeps,
    readonly runnerId: string,
    private readonly link: RunnerLink,
  ) {}

  private send(msg: ServerMessage): void {
    this.link.send(msg);
  }

  private touch(): void {
    this.deps.db.update(runners).set({ lastSeenAt: Date.now() }).where(eq(runners.id, this.runnerId)).run();
  }

  /** Per non-terminal run held by this runner: highest persisted seq (0 when none). */
  lastAckedSeq(): Record<string, number> {
    const rows = this.deps.db
      .select({ runId: runs.id, seq: max(runEvents.seq) })
      .from(runs)
      .leftJoin(runEvents, eq(runEvents.runId, runs.id))
      .where(and(eq(runs.runnerId, this.runnerId), inArray(runs.status, [...ACTIVE_STATUSES])))
      .groupBy(runs.id)
      .all();
    return Object.fromEntries(rows.map((r) => [r.runId, r.seq ?? 0]));
  }

  /** Parses and dispatches one text frame. Invalid frames are logged and dropped. */
  async handle(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      console.warn(`[runner ${this.runnerId}] dropped non-JSON frame`);
      return;
    }
    const parsed = RunnerMessage.safeParse(json);
    if (!parsed.success) {
      const t = (json as { t?: unknown } | null)?.t;
      console.warn(`[runner ${this.runnerId}] dropped invalid ${String(t)} message: ${parsed.error.issues[0]?.message}`);
      return;
    }
    await this.dispatch(parsed.data);
  }

  async dispatch(msg: RunnerMessage): Promise<void> {
    const { deps } = this;
    switch (msg.t) {
      case "hello": {
        if (msg.runnerId !== this.runnerId) {
          console.warn(`[runner ${this.runnerId}] hello.runnerId "${msg.runnerId}" differs from the token's runner id`);
        }
        deps.db
          .update(runners)
          .set({ capabilities: msg.capabilities, lastSeenAt: Date.now() })
          .where(eq(runners.id, this.runnerId))
          .run();
        if (!this.attached) {
          deps.hub.attachRunner(this.runnerId, this.link);
          this.attached = true;
        }
        this.send({ t: "welcome", lastAckedSeq: this.lastAckedSeq() });
        console.log(`[runner ${this.runnerId}] hello v${msg.version}, labels=${msg.capabilities.labels.join(",") || "-"}`);
        deps.scheduler.kick();
        return;
      }
      case "ping":
        this.touch();
        this.send({ t: "pong" });
        return;
      case "job.accepted":
        console.log(`[runner ${this.runnerId}] accepted run ${msg.runId}`);
        return;
      case "job.rejected": {
        if (!this.holds(msg.runId)) return;
        console.warn(`[runner ${this.runnerId}] rejected run ${msg.runId}: ${msg.reason}`);
        deps.runs.terminate(msg.runId, "failed", msg.reason);
        deps.scheduler.kick();
        return;
      }
      case "job.events": {
        const events = msg.events.filter((e) => e.runId === msg.runId);
        if (events.length === 0) return;
        // Events for runs this runner does not hold are acked (so the outbox drains) but not stored.
        const seq = this.holds(msg.runId)
          ? deps.runs.ingest(msg.runId, events)
          : events.reduce((m, e) => Math.max(m, e.seq), 0);
        this.send({ t: "job.ack", runId: msg.runId, seq });
        return;
      }
      case "job.finished": {
        if (!this.holds(msg.runId)) return;
        deps.runs.finish(msg.runId, msg.status, msg.error);
        deps.scheduler.kick();
        return;
      }
      case "rpc.result": {
        deps.hub.resolveRpc(this.runnerId, msg.rpcId, msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error });
        return;
      }
      case "rpc.call": {
        this.send(await handleRunnerRpc(deps, this.runnerId, msg));
        return;
      }
    }
  }

  private holds(runId: string): boolean {
    const run = this.deps.runs.get(runId);
    if (run?.runnerId === this.runnerId) return true;
    console.warn(`[runner ${this.runnerId}] message for run ${runId} it does not hold`);
    return false;
  }

  close(): void {
    if (this.attached) this.deps.hub.detachRunner(this.runnerId, this.link);
    this.attached = false;
  }
}

export function registerRunnerWs(app: Hono, deps: AppDeps): void {
  app.get(
    "/runner/ws",
    upgradeWebSocket((c) => {
      const runnerId = authenticateRunner(deps, c.req.header("authorization"));
      let session: RunnerSession | null = null;
      return {
        onOpen(_evt, ws) {
          if (!runnerId) {
            ws.close(4401, "unauthorized");
            return;
          }
          session = new RunnerSession(deps, runnerId, {
            send: (msg) => ws.send(JSON.stringify(msg)),
            close: (code, reason) => ws.close(code, reason),
          });
          console.log(`[runner ${runnerId}] connected`);
        },
        onMessage(evt) {
          if (!session || typeof evt.data !== "string") return;
          session.handle(evt.data).catch((err) => console.error(`[runner ${runnerId}] handler failed:`, err));
        },
        onClose() {
          if (!session) return;
          session.close();
          console.log(`[runner ${runnerId}] disconnected`);
        },
      };
    }),
  );
}
