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
  private session: acp.ActiveSession | null = null;
  private cwd = "";

  constructor(private readonly opts: AcpHarnessOptions) {}

  /** Execs the harness and performs `initialize`. */
  async start(sandbox: Sandbox, argv: string[], cwd: string): Promise<acp.InitializeResponse> {
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

  /** Starts a fresh ACP session, replacing the current one. */
  async newSession(): Promise<void> {
    if (!this.conn) throw new Error("Harness not started");
    this.session?.dispose();
    this.session = null;
    this.session = await this.conn.agent.buildSession(this.cwd).withMcpServer(this.opts.mcpServer).start();
  }

  /** Runs one prompt turn, forwarding every `session/update` to `onUpdate`. */
  async prompt(text: string, onUpdate: (update: acp.SessionUpdate) => void): Promise<{ stopReason: acp.StopReason }> {
    const session = this.session;
    if (!session) throw new Error("No active ACP session");
    void session.prompt(text).catch(() => {
      // surfaced through nextUpdate()
    });
    for (;;) {
      const msg = await session.nextUpdate();
      if (msg.kind === "stop") return { stopReason: msg.stopReason };
      onUpdate(msg.update);
    }
  }

  async cancel(): Promise<void> {
    const session = this.session;
    if (!this.conn || !session) return;
    try {
      await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
    } catch {
      // connection already gone
    }
  }

  async close(): Promise<void> {
    this.session?.dispose();
    this.session = null;
    this.conn?.close();
    this.conn = null;
    this.proc?.kill();
    this.proc = null;
  }
}
