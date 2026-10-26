import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Finding, StructuredOutput } from "@orch/protocol";
import { z } from "zod";
import type { RunnerConfig } from "./config";

export interface McpOutputServer {
  /** `getSpec` returns the active agent step's structured-output spec; it is evaluated per MCP request so the tool schema follows the step. */
  registerRun(runId: string, sink: McpRunSink, getSpec?: () => StructuredOutput | undefined): { url: string /* sandbox-side URL */; secret: string };
  unregisterRun(runId: string): void;
  stop(): Promise<void>;
}

export interface McpRunSink {
  /** Returns error text (e.g. "No active step") or null on success. */
  submitOutput(value: unknown): string | null;
  reportFinding(f: Finding): string | null;
}

const toolText = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });

function buildServer(sink: McpRunSink, spec?: StructuredOutput): McpServer {
  const server = new McpServer({ name: "orchestrator", version: "0.1.0" });
  const outputField =
    spec === undefined
      ? z.any().describe("Any JSON value")
      : z.looseObject(
          Object.fromEntries(spec.fields.map((f) => [f.name, z.unknown().describe(`${f.description} (required)`)])),
        ).describe(
          `JSON object with the step's structured fields: ${spec.fields.map((f) => f.name).join(", ")}. Every field is required.`,
        );
  server.registerTool(
    "submit_output",
    {
      description:
        spec === undefined
          ? "Submit the structured (JSON) result of the current orchestrator step. Later steps can reference it as steps.<id>.structured."
          : `Submit the structured (JSON) result of the current orchestrator step: a JSON object with the fields ${spec.fields.map((f) => f.name).join(", ")}. Every field is required. Later steps can reference it as steps.<id>.structured.<field>.`,
      inputSchema: { output: outputField },
    },
    async ({ output }) => {
      const err = sink.submitOutput(output);
      return err ? toolText(err, true) : toolText("ok");
    },
  );
  server.registerTool(
    "report_finding",
    {
      description: "Report a code finding (bug, vulnerability, style issue) at a repository-relative file location.",
      inputSchema: {
        file: z.string().describe("Repository-relative file path"),
        line: z.number().int().min(1),
        endLine: z.number().int().min(1).optional(),
        severity: z.enum(["error", "warning", "info"]),
        message: z.string().max(2000),
        ruleId: z.string().max(100).optional(),
      },
    },
    async (f) => {
      if (!f.file || f.file.startsWith("/") || f.file.split(/[\\/]/).includes("..")) {
        return toolText("file must be a repository-relative path", true);
      }
      if (f.endLine !== undefined && f.endLine < f.line) return toolText("endLine must be >= line", true);
      const err = sink.reportFinding(f);
      return err ? toolText(err, true) : toolText("ok");
    },
  );
  return server;
}

function secretMatches(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Per-run MCP endpoint `/mcp/<runId>` (stateless Streamable HTTP), reachable from sandboxes via the egress proxy. */
export async function startMcpServer(cfg: RunnerConfig): Promise<McpOutputServer> {
  const runs = new Map<string, { secret: string; sink: McpRunSink; getSpec?: () => StructuredOutput | undefined }>();
  const fetch = async (req: Request): Promise<Response> => {
    const m = /^\/mcp\/([^/]+)$/.exec(new URL(req.url).pathname);
    const run = m ? runs.get(m[1]!) : undefined;
    if (!run) return new Response("Not found", { status: 404 });
    if (!secretMatches(req.headers.get("authorization"), run.secret)) return new Response("Unauthorized", { status: 401 });
    const mcp = buildServer(run.sink, run.getSpec?.());
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void mcp.close();
    }
  };

  let server;
  try {
    server = Bun.serve({ hostname: cfg.hostBind, port: cfg.ports.mcp, idleTimeout: 0, fetch });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
      throw new Error(`Port ${cfg.ports.mcp} in use (mcp); set ports.mcp in runner.json`);
    }
    throw err;
  }
  const bunServer = server;

  return {
    /** `getSpec` returns the active agent step's structured spec, so `buildServer` can type the tool schema. */
    registerRun(runId, sink, getSpec) {
      const secret = randomBytes(32).toString("base64url");
      runs.set(runId, { secret, sink, ...(getSpec ? { getSpec } : {}) });
      return { url: `http://host.docker.internal:${cfg.ports.mcp}/mcp/${runId}`, secret };
    },
    unregisterRun(runId) {
      runs.delete(runId);
    },
    async stop() {
      runs.clear();
      await bunServer.stop(true);
    },
  };
}
