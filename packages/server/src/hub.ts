import type { RunEvent, ServerMessage } from "@orch/protocol";
import { ulid } from "ulid";

/** A live runner WebSocket as seen by the rest of the server. */
export interface RunnerLink {
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export class RpcError extends Error {
  constructor(
    readonly kind: "offline" | "timeout" | "remote",
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface PendingRpc {
  runnerId: string;
  resolve(value: unknown): void;
  reject(err: RpcError): void;
  timer: Timer;
}

type Subscriber = (event: RunEvent) => void;

/** In-memory fan-out: browser subscribers per run, connected runners, and server→runner RPCs. */
export class Hub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  /** Server-side observers of every persisted event (e.g. GitHub check reporting). */
  private readonly listeners = new Set<Subscriber>();
  private readonly runners = new Map<string, RunnerLink>();
  /** Links that finished their post-`welcome` outbox replay (`replayed`); only these get jobs. */
  private readonly replayed = new WeakSet<RunnerLink>();
  private readonly rpcs = new Map<string, PendingRpc>();

  subscribe(runId: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(runId);
    if (!set) this.subscribers.set(runId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subscribers.delete(runId);
    };
  }

  /** Registers an observer of every run's fresh events; returns the unregister function. */
  onEvent(fn: Subscriber): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(event: RunEvent): void {
    for (const fn of [...this.listeners, ...(this.subscribers.get(event.runId) ?? [])]) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[hub] subscriber for ${event.runId} failed:`, err);
      }
    }
  }

  /** Registers a runner link, closing any previous link for the same runner. */
  attachRunner(runnerId: string, link: RunnerLink): void {
    const prev = this.runners.get(runnerId);
    this.runners.set(runnerId, link);
    if (prev && prev !== link) prev.close(4409, "replaced by a newer connection");
  }

  /** Removes the link if it is still the current one; fails its pending RPCs. */
  detachRunner(runnerId: string, link: RunnerLink): void {
    if (this.runners.get(runnerId) !== link) return;
    this.runners.delete(runnerId);
    for (const [rpcId, p] of this.rpcs) {
      if (p.runnerId !== runnerId) continue;
      clearTimeout(p.timer);
      this.rpcs.delete(rpcId);
      p.reject(new RpcError("offline", "runner disconnected"));
    }
  }

  isConnected(runnerId: string): boolean {
    return this.runners.has(runnerId);
  }

  /** Records whether `link` finished replaying its outbox; `hello` resets it, `replayed` sets it. */
  setReplayed(link: RunnerLink, replayed: boolean): void {
    if (replayed) this.replayed.add(link);
    else this.replayed.delete(link);
  }

  /** True when the runner's current connection finished replaying its outbox. */
  isReplayed(runnerId: string): boolean {
    const link = this.runners.get(runnerId);
    return link !== undefined && this.replayed.has(link);
  }

  /** Returns false when the runner has no live connection. */
  sendToRunner(runnerId: string, msg: ServerMessage): boolean {
    const link = this.runners.get(runnerId);
    if (!link) return false;
    link.send(msg);
    return true;
  }

  rpc<T>(runnerId: string, method: "fs.list", params: { path: string }, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const rpcId = ulid();
      if (!this.sendToRunner(runnerId, { t: "rpc.call", rpcId, method, params })) {
        reject(new RpcError("offline", "runner offline"));
        return;
      }
      const timer = setTimeout(() => {
        this.rpcs.delete(rpcId);
        reject(new RpcError("timeout", `runner did not answer ${method} within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.rpcs.set(rpcId, { runnerId, resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  /** Completes a server-initiated RPC; results from a runner that did not receive the call are ignored. */
  resolveRpc(runnerId: string, rpcId: string, outcome: { ok: true; result: unknown } | { ok: false; error: string }): void {
    const p = this.rpcs.get(rpcId);
    if (!p || p.runnerId !== runnerId) return;
    clearTimeout(p.timer);
    this.rpcs.delete(rpcId);
    if (outcome.ok) p.resolve(outcome.result);
    else p.reject(new RpcError("remote", outcome.error));
  }
}
