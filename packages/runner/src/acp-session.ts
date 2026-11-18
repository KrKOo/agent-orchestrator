import * as acp from "@agentclientprotocol/sdk";
import type { Sandbox, SandboxProcess } from "./sandbox/types";

export interface AcpHarnessOptions {
  approval: "auto" | "ask";
  /** Orchestrator MCP server injected into every session. */
  mcpServer: acp.McpServer;
  onPermission(req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  /** Form-mode elicitations only; other modes are declined before reaching this callback. */
  onElicitation(req: { message: string; requestedSchema: unknown }): Promise<acp.CreateElicitationResponse>;
  onLog(stream: "stdout" | "stderr", text: string): void;
}

async function pipeLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    }
  } catch {
    // stream torn down with the process
  }
  if (buf.trim()) onLine(buf.trimEnd());
}

/** ACP client over a harness process running inside a sandbox. */
export class AcpHarness {
  private proc: SandboxProcess | null = null;
  private conn: acp.ClientConnection | null = null;
  private sandbox: Sandbox | null = null;
  private argv: string[] = [];
  private cwd = "";
  private session: string | null = null;
  /** Latest config options of the session (`session/new`, `session/load`, `config_option_update`). */
  private configOptions: acp.SessionConfigOption[] = [];
  /** Receives the session's updates while a prompt turn runs; anything else (e.g. `session/load` history) is dropped. */
  private onUpdate: ((update: acp.SessionUpdate) => void) | null = null;
  /** Main model to keep the session on: re-applied to every new or loaded session. */
  private wantedModel: string | undefined;

  constructor(private readonly opts: AcpHarnessOptions) {}

  get sessionId(): string | null {
    return this.session;
  }

  /** Execs the harness and performs `initialize`. */
  async start(sandbox: Sandbox, argv: string[], cwd: string): Promise<acp.InitializeResponse> {
    this.sandbox = sandbox;
    this.argv = argv;
    this.cwd = cwd;
    const proc = sandbox.exec(argv, cwd);
    this.proc = proc;
    void pipeLines(proc.stderr, (line) => this.opts.onLog("stderr", line));

    const app = acp
      .client({ name: "agent-orchestrator" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.opts.onPermission(params))
      .onRequest(acp.methods.client.elicitation.create, async ({ params }) => {
        if (params.mode !== "form" || !("requestedSchema" in params)) return { action: "decline" };
        return this.opts.onElicitation({ message: params.message, requestedSchema: params.requestedSchema });
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.sessionId !== this.session) return;
        if (params.update.sessionUpdate === "config_option_update") this.configOptions = params.update.configOptions;
        this.onUpdate?.(params.update);
      });
    this.conn = app.connect(acp.ndJsonStream(proc.stdin, proc.stdout));

    const exited = proc.exited.then((code) => {
      throw new Error(`Harness exited with code ${code} before initialize`);
    });
    return Promise.race([
      this.conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "agent-orchestrator", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          ...(this.opts.approval === "ask" ? { elicitation: { form: {} } } : {}),
        },
      }),
      exited,
    ]);
  }

  private connection(): acp.ClientConnection {
    if (!this.conn) throw new Error("Harness not started");
    return this.conn;
  }

  /** Starts a fresh ACP session, replacing the current one. */
  async newSession(): Promise<void> {
    const conn = this.connection();
    this.session = null;
    const res = await conn.agent.request(acp.methods.agent.session.new, { cwd: this.cwd, mcpServers: [this.opts.mcpServer] });
    this.session = res.sessionId;
    this.configOptions = res.configOptions ?? [];
    await this.applyWantedModel();
  }

  /**
   * Loads session `sessionId` (persisted by an earlier harness process) into this one. omp replays its history as
   * `session/update`s; no prompt is in flight, so they are dropped. `prepare` runs when the harness does not list
   * the session (see `HarnessAdapter.prepareLoadArgv`). Verified on omp 18.22.2: the conversation continues.
   */
  async loadSession(sessionId: string, prepare?: (sessionId: string) => Promise<void>): Promise<void> {
    const conn = this.connection();
    if (prepare) {
      const listed = await conn.agent.request(acp.methods.agent.session.list, { cwd: this.cwd });
      if (!listed.sessions.some((s) => s.sessionId === sessionId)) await prepare(sessionId);
    }
    this.session = sessionId;
    const res = await conn.agent.request(acp.methods.agent.session.load, { sessionId, cwd: this.cwd, mcpServers: [this.opts.mcpServer] });
    this.configOptions = res.configOptions ?? [];
    await this.applyWantedModel();
  }

  /**
   * Restarts the harness process (it re-reads its config files) and loads the current session into it, so the
   * conversation carries on. Only between prompt turns.
   */
  async restart(prepare?: (sessionId: string) => Promise<void>): Promise<void> {
    const sessionId = this.session;
    const sandbox = this.sandbox;
    if (!sessionId || !sandbox) throw new Error("No ACP session to restart");
    const old = this.proc;
    await this.close();
    // The old process exits on stdin EOF; wait for it so two processes never write the session at once.
    await old?.exited;
    await this.start(sandbox, this.argv, this.cwd);
    await this.loadSession(sessionId, prepare);
  }

  /** The session's `model` select option with its values (option groups flattened), if the harness offers one. */
  private modelOption(): { id: string; current: string; values: string[] } | undefined {
    const option = this.configOptions.find((o) => o.category === "model");
    if (option?.type !== "select") return undefined;
    const values = option.options.flatMap((o) => ("options" in o ? o.options.map((g) => g.value) : [o.value]));
    return { id: option.id, current: option.currentValue, values };
  }

  /** Whether the session offers main model `id` (switchable live with `setModel`). */
  offersModel(id: string): boolean {
    return this.modelOption()?.values.includes(id) ?? false;
  }

  /** Main model the session runs on, as its `model` config option reports it. */
  get sessionModel(): string | undefined {
    return this.modelOption()?.current;
  }

  /**
   * Keeps the session on main model `id` from now on (also every later new or loaded session) and switches the
   * current session to it, even mid-turn: omp applies it to its next model request. False when the session does
   * not offer `id` (or there is no session yet); it then applies only to sessions that offer it.
   */
  async setModel(id: string): Promise<boolean> {
    this.wantedModel = id;
    return this.applyWantedModel();
  }

  private async applyWantedModel(): Promise<boolean> {
    const id = this.wantedModel;
    const option = this.modelOption();
    if (id === undefined || !this.conn || !this.session || !option?.values.includes(id)) return false;
    if (option.current === id) return true;
    const res = await this.conn.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: this.session, configId: option.id, value: id });
    this.configOptions = res.configOptions;
    return true;
  }

  /** Runs one prompt turn, forwarding every `session/update` to `onUpdate`. */
  async prompt(text: string, onUpdate: (update: acp.SessionUpdate) => void): Promise<{ stopReason: acp.StopReason }> {
    const conn = this.connection();
    const sessionId = this.session;
    if (!sessionId) throw new Error("No active ACP session");
    this.onUpdate = onUpdate;
    try {
      const res = await conn.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
      // Notification handlers run a few microtasks after their message is read, while the response settles at
      // once: a macrotask lets updates sent before the response reach `onUpdate` first.
      await Bun.sleep(0);
      return { stopReason: res.stopReason };
    } finally {
      this.onUpdate = null;
    }
  }

  async cancel(): Promise<void> {
    if (!this.conn || !this.session) return;
    try {
      await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.session });
    } catch {
      // connection already gone
    }
  }

  async close(): Promise<void> {
    this.onUpdate = null;
    this.conn?.close();
    this.conn = null;
    this.proc?.kill();
    this.proc = null;
  }
}
