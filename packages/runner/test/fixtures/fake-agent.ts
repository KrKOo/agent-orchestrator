/**
 * Scripted ACP agent (no LLM) for runJob tests. Every prompt streams three `agent_message_chunk`s
 * ("Hello", ", ", "world") and one `tool_call`, then ends with `end_turn`. Prompt keywords:
 * - `write <file>`: first creates <file> (content "hi\n") in the session cwd.
 * - `slow`: waits for `session/cancel` and ends with `cancelled`.
 * - `ask`: requests permission first and streams the chosen optionId (or "denied") as a fourth chunk.
 * - `read <file>`: streams the content of <file> (relative to the session cwd) as an extra chunk.
 * - `echo`: streams the full prompt text as the last chunk.
 * - `submit <json>`: calls the orchestrator MCP server's `submit_output` tool with <json> (via the
 *   `mcpServers` entry of `session/new`, stateless HTTP with JSON responses) and streams the tool's
 *   text result as an extra chunk; `submit retry <json>` expects the first call to fail, then retries
 *   after a `fixup` chunk.
 * - `probe`: first calls `tools/list` on the orchestrator MCP server and streams the raw JSON result
 *   as an extra chunk (prefixed `probe: `); used to assert the per-step tool schema.
 * - `submit-array <json>` / `submit-null`: call `submit_output` with an array / null and stream the result.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map<string, { cwd: string; cancel: PromiseWithResolvers<void>; mcpUrl?: string; mcpSecret?: string }>();
let nextId = 0;

/** Calls a tool on the orchestrator MCP server; returns the raw JSON-RPC result. */
async function callTool(
  mcpUrl: string,
  secret: string,
  method: string,
  params: unknown,
): Promise<{ isError: boolean; text: string }> {
  // The URL is the sandbox-side address (`host.docker.internal`); tests run on the host, so map it.
  const url = new URL(mcpUrl);
  if (url.hostname === "host.docker.internal") url.hostname = "127.0.0.1";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: { content?: { type: string; text: string }[]; isError?: boolean } };
  const text = body.result?.content?.find((c) => c.type === "text")?.text ?? (body.result ? JSON.stringify(body.result) : "");
  return { isError: body.result?.isError === true, text };
}

const submitOutput = async (mcpUrl: string, secret: string, output: unknown): Promise<string> => {
  const r = await callTool(mcpUrl, secret, "tools/call", { name: "submit_output", arguments: { output } });
  return `${r.isError ? "error: " : "ok: "}${r.text}`;
};

const stdout = new WritableStream<Uint8Array>({
  write(chunk) {
    process.stdout.write(chunk);
  },
});

const app = acp
  .agent({ name: "fake-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { mcpCapabilities: { http: true, sse: false } },
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = `fake-${++nextId}`;
    const http = params.mcpServers?.find((s): s is Extract<acp.McpServer, { type: "http" }> => "type" in s && s.type === "http");
    const auth = http?.headers.find((h) => h.name.toLowerCase() === "authorization")?.value;
    sessions.set(sessionId, {
      cwd: params.cwd,
      cancel: Promise.withResolvers<void>(),
      ...(http?.url ? { mcpUrl: http.url } : {}),
      ...(auth?.startsWith("Bearer ") ? { mcpSecret: auth.slice("Bearer ".length) } : {}),
    });
    return { sessionId };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.cancel.resolve();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    const chunk = (t: string) =>
      client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } },
      });

    const write = /\bwrite (\S+)/.exec(text);
    if (write) writeFileSync(join(session.cwd, write[1]!), "hi\n");

    if (text.includes("slow")) {
      process.stderr.write("fake-agent: waiting for cancel\n");
      await chunk("Counting");
      await session.cancel.promise;
      return { stopReason: "cancelled" };
    }

    for (const t of ["Hello", ", ", "world"]) await chunk(t);
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Read a.txt", kind: "read", status: "completed" },
    });

    if (text.includes("ask")) {
      const res = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call_2", title: "Run ls", kind: "execute" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      await chunk(res.outcome.outcome === "selected" ? ` ${res.outcome.optionId}` : " denied");
    }
    const read = /\bread (\S+)/.exec(text);
    if (read) await chunk(`\n${readFileSync(join(session.cwd, read[1]!), "utf8")}`);
    if (text.includes("echo")) await chunk(`\n${text}`);
    if (text.includes("probe") && session.mcpUrl && session.mcpSecret) {
      await chunk(`\nprobe: ${(await callTool(session.mcpUrl, session.mcpSecret, "tools/list", {})).text}`);
    }
    const submit = /\bsubmit (retry )?(\{.*\})/s.exec(text);
    if (submit && session.mcpUrl && session.mcpSecret) {
      const payload = JSON.parse(submit[2]!) as Record<string, unknown>;
      if (submit[1]) {
        // First call omits the last declared field (the model forgot); the runner's error text loops it back in.
        const first = { ...payload };
        const lastKey = Object.keys(first).at(-1);
        if (lastKey !== undefined) delete first[lastKey];
        await chunk(`\n${await submitOutput(session.mcpUrl, session.mcpSecret, first)}`);
        await chunk(`\n${await submitOutput(session.mcpUrl, session.mcpSecret, payload)}`);
      } else {
        await chunk(`\n${await submitOutput(session.mcpUrl, session.mcpSecret, payload)}`);
      }
    }
    if (text.includes("submit-empty") && session.mcpUrl && session.mcpSecret) {
      await chunk(`\n${await submitOutput(session.mcpUrl, session.mcpSecret, {})}`);
    }
    const submitArray = /\bsubmit-array (\[.*\])/s.exec(text);
    if (submitArray && session.mcpUrl && session.mcpSecret) {
      await chunk(`\n${await submitOutput(session.mcpUrl, session.mcpSecret, JSON.parse(submitArray[1]!))}`);
    }
    if (text.includes("submit-null") && session.mcpUrl && session.mcpSecret) {
      await chunk(`\n${await submitOutput(session.mcpUrl, session.mcpSecret, null)}`);
    }
    return { stopReason: "end_turn" };
  });

await app.connect(acp.ndJsonStream(stdout, Bun.stdin.stream())).closed;
