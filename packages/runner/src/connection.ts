import { ServerMessage, type RunnerMessage } from "@orch/protocol";
import { ulid } from "ulid";

export type RunnerRpcMethod = "github.token" | "github.createPullRequest";

export interface ConnectionOptions {
  url: string;
  token: string;
  /** Called on every (re)connect before anything else is sent; must send `hello`. */
  onOpen(): void | Promise<void>;
  /** Every server message except `rpc.result` and `pong`, which the connection handles itself. */
  onMessage(msg: ServerMessage): void;
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
/** No frame from the server for this long → the socket is considered dead. */
const IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_RPC_TIMEOUT_MS = 60_000;

interface PendingRpc {
  method: RunnerRpcMethod;
  params: unknown;
  sent: boolean;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: Timer;
}

/** Unchecked: Bun's WebSocket accepts `{headers}`; the lib.dom typing in our tsconfig hides that overload. */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

/** Outbound WebSocket to the server with reconnect/backoff, keepalive, and runner→server RPC. */
export class Connection {
  private ws: WebSocket | null = null;
  private open = false;
  private stopped = true;
  private backoff = BACKOFF_MIN_MS;
  private reconnectTimer: Timer | undefined;
  private pingTimer: Timer | undefined;
  private lastReceived = 0;
  private readonly rpcs = new Map<string, PendingRpc>();

  constructor(private readonly opts: ConnectionOptions) {}

  get connected(): boolean {
    return this.open;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.dropSocket(1000, "runner shutting down");
    for (const [id, rpc] of this.rpcs) {
      clearTimeout(rpc.timer);
      rpc.reject(new Error("Connection stopped"));
      this.rpcs.delete(id);
    }
  }

  /** Sends when connected; drops otherwise (the outbox handles durability for job.events). */
  send(msg: RunnerMessage): void {
    if (!this.open || !this.ws) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error(`[conn] send failed: ${(err as Error).message}`);
    }
  }

  /** Runner→server RPC. Calls made while disconnected are sent once the connection is back. */
  rpc<T>(method: RunnerRpcMethod, params: unknown, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<T> {
    const rpcId = ulid();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpcs.delete(rpcId);
        reject(new Error(`RPC ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      // Unchecked: the server's result payload for `method` is T by protocol contract.
      const settle = resolve as (value: unknown) => void;
      const pending: PendingRpc = { method, params, sent: false, resolve: settle, reject, timer };
      this.rpcs.set(rpcId, pending);
      if (this.open) this.sendRpc(rpcId, pending);
    });
  }

  private sendRpc(rpcId: string, rpc: PendingRpc): void {
    rpc.sent = true;
    // Unchecked: params are validated by the server against the method's schema.
    this.send({ t: "rpc.call", rpcId, method: rpc.method, params: rpc.params } as RunnerMessage);
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new BunWebSocket(this.opts.url, { headers: { Authorization: `Bearer ${this.opts.token}` } });
    } catch (err) {
      console.error(`[conn] cannot connect to ${this.opts.url}: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.lastReceived = Date.now();
      console.log(`[conn] connected to ${this.opts.url}`);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.keepalive(), PING_INTERVAL_MS);
      void (async () => {
        try {
          await this.opts.onOpen();
        } catch (err) {
          console.error(`[conn] onOpen failed: ${(err as Error).message}`);
        }
        if (this.ws !== ws || !this.open) return;
        for (const [id, rpc] of this.rpcs) if (!rpc.sent) this.sendRpc(id, rpc);
      })();
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastReceived = Date.now();
      let json: unknown;
      try {
        json = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      } catch {
        console.error("[conn] ignoring non-JSON frame");
        return;
      }
      const parsed = ServerMessage.safeParse(json);
      if (!parsed.success) {
        console.error(`[conn] ignoring invalid server message: ${parsed.error.issues[0]?.message ?? "unknown"}`);
        return;
      }
      const msg = parsed.data;
      if (msg.t === "pong") return;
      if (msg.t === "rpc.result") {
        const rpc = this.rpcs.get(msg.rpcId);
        if (!rpc) return;
        this.rpcs.delete(msg.rpcId);
        clearTimeout(rpc.timer);
        if (msg.ok) rpc.resolve(msg.result);
        else rpc.reject(new Error(msg.error));
        return;
      }
      if (msg.t === "welcome") this.backoff = BACKOFF_MIN_MS;
      try {
        this.opts.onMessage(msg);
      } catch (err) {
        console.error(`[conn] handler for ${msg.t} failed: ${(err as Error).message}`);
      }
    };

    ws.onerror = () => {
      // The close event follows and drives reconnection.
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      if (ev.code === 4401) {
        console.error("[conn] server rejected the runner token (4401); check `token` in runner.json");
      } else if (this.open) {
        console.warn(`[conn] disconnected (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`);
      }
      this.handleDisconnect();
    };
  }

  private keepalive(): void {
    if (!this.open) return;
    if (Date.now() - this.lastReceived > IDLE_TIMEOUT_MS) {
      console.warn("[conn] server silent for too long; reconnecting");
      this.dropSocket(4000, "idle timeout");
      this.handleDisconnect();
      return;
    }
    this.send({ t: "ping" });
  }

  /** Detaches and closes the current socket without triggering its close handler. */
  private dropSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    clearInterval(this.pingTimer);
    if (!ws) return;
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  private handleDisconnect(): void {
    this.ws = null;
    this.open = false;
    clearInterval(this.pingTimer);
    // The server cannot answer calls made on a dead socket; fail them instead of re-sending side effects.
    for (const [id, rpc] of this.rpcs) {
      if (!rpc.sent) continue;
      clearTimeout(rpc.timer);
      this.rpcs.delete(id);
      rpc.reject(new Error(`Connection lost during RPC ${rpc.method}`));
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
