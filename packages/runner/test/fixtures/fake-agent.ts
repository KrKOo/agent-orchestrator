/**
 * Scripted ACP agent (no LLM) for runJob tests. Every prompt streams three `agent_message_chunk`s
 * ("Hello", ", ", "world") and one `tool_call`, then ends with `end_turn`. Prompt keywords:
 * - `write <file>`: first creates <file> (content "hi\n") in the session cwd.
 * - `slow`: waits for `session/cancel` and ends with `cancelled`.
 * - `ask`: requests permission first and streams the chosen optionId (or "denied") as a fourth chunk.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map<string, { cwd: string; cancel: PromiseWithResolvers<void> }>();
let nextId = 0;

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
    sessions.set(sessionId, { cwd: params.cwd, cancel: Promise.withResolvers<void>() });
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
    return { stopReason: "end_turn" };
  });

await app.connect(acp.ndJsonStream(stdout, Bun.stdin.stream())).closed;
