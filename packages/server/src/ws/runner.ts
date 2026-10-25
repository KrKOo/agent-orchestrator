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
import { neutralizeMentions } from "../github/sanitize";
import type { RunnerLink } from "../hub";
import { isTerminal } from "../runs";
import { ACTIVE_STATUSES } from "../scheduler";

const { runners, runs, runEvents } = schema;

/** GitHub caps comment bodies at 65 536 chars; stay well below. */
const MAX_COMMENT_CHARS = 60_000;

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
 * Answers a runner-initiated RPC; only the runner holding the (non-terminal) run may call.
 * - `github.token` `read`: owner runs, or untrusted runs for their own PR repository.
 * - `github.token` `write` and `github.createPullRequest`: owner runs only.
 * - `github.createComment`: a `github_comment` step of the run; the target issue/PR comes from the run's stored inputs.
 * Everything else gets `forbidden`.
 */
export async function handleRunnerRpc(deps: AppDeps, runnerId: string, call: RunnerRpcCall): Promise<RpcResult> {
  const { rpcId } = call;
  const forbidden: RpcResult = { t: "rpc.result", rpcId, ok: false, error: "forbidden" };
  const run = deps.runs.get(call.params.runId);
  if (!run || run.runnerId !== runnerId || isTerminal(run.status)) return forbidden;
  const gh = run.github;
  try {
    switch (call.method) {
      case "github.token": {
        const { repo, access } = call.params;
        const ownRepo = gh !== null && repo.toLowerCase() === gh.repo.toLowerCase();
        const allowed = run.trust === "owner" || (access === "read" && ownRepo);
        if (!allowed) return forbidden;
        const token = await deps.credentials.tokenFor(repo, access, ownRepo ? gh?.installationId : undefined);
        return { t: "rpc.result", rpcId, ok: true, result: { token } };
      }
      case "github.createPullRequest": {
        if (run.trust !== "owner") return forbidden;
        const { repo, head, base, title, body, draft } = call.params;
        const token = await deps.credentials.tokenFor(repo, "write");
        const result = await deps.github.createPullRequest(token, { repo, head, base, title, body, draft });
        return { t: "rpc.result", rpcId, ok: true, result };
      }
      case "github.createComment": {
        const step = run.definition.steps.find((s) => s.id === call.params.stepId);
        if (step?.kind !== "github_comment") return forbidden;
        const def = run.definition.inputs.find((i) => i.key === step.target);
        const target = run.inputs[step.target] as { repo: string; number: number } | null | undefined;
        if (!def || !target) throw new Error(`Input "${step.target}" has no issue or pull request`);
        const ownRepo = gh !== null && target.repo.toLowerCase() === gh.repo.toLowerCase();
        // PR conversations take pull_requests write (the reporting token); issues need issues write.
        const access = def.type === "github_pull_request" ? "report" : "comment";
        const token = await deps.credentials.tokenFor(target.repo, access, ownRepo ? gh?.installationId : undefined);
        const body = neutralizeMentions(call.params.body.trim(), MAX_COMMENT_CHARS);
        const result = await deps.github.createIssueComment(token, target.repo, target.number, body);
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
        // No jobs until the runner has replayed its outbox in answer to this welcome (`replayed`).
        deps.hub.setReplayed(this.link, false);
        this.send({ t: "welcome", lastAckedSeq: this.lastAckedSeq() });
        console.log(`[runner ${this.runnerId}] hello v${msg.version}, labels=${msg.capabilities.labels.join(",") || "-"}`);
        return;
      }
      case "replayed":
        if (!this.attached) return;
        deps.hub.setReplayed(this.link, true);
        deps.scheduler.kick();
        return;
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
