import type { SessionUpdate } from "@orch/protocol";
import { z } from "zod";

/**
 * Translates `omp -p --mode json` NDJSON events into the ACP `SessionUpdate`s the web UI already
 * renders for agent steps, so slash-command runs stream the same way: text deltas as
 * `agent_message_chunk`s, tool executions as `tool_call`/`tool_call_update` cards.
 *
 * Shapes verified against omp 18.10.3:
 *   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"..."}}
 *   {"type":"tool_execution_start","toolCallId":"…","toolName":"bash","args":{…},"intent":"…"}
 *   {"type":"tool_execution_update","toolCallId":"…","partialResult":{"content":[{"type":"text","text":"…"}]}}
 *   {"type":"tool_execution_end","toolCallId":"…","result":{"content":[…]},"isError":false}
 *   {"type":"agent_end","messages":[user and assistant message objects]}
 */

/** Tool message content: text blocks (other block types are dropped by the renderer anyway). */
const ContentBlocks = z.array(z.looseObject({ type: z.string().optional(), text: z.string().optional() }));

const TextDelta = z.object({
  type: z.literal("message_update"),
  assistantMessageEvent: z.object({ type: z.literal("text_delta"), delta: z.string() }).passthrough(),
});

const ThoughtDelta = z.object({
  type: z.literal("message_update"),
  assistantMessageEvent: z.object({ type: z.literal("thinking_delta"), delta: z.string() }).passthrough(),
});

const ToolStart = z.object({
  type: z.literal("tool_execution_start"),
  toolCallId: z.string(),
  toolName: z.string(),
  intent: z.string().optional(),
  args: z.unknown().optional(),
});

const ToolUpdate = z.object({
  type: z.literal("tool_execution_update"),
  toolCallId: z.string(),
  partialResult: z.looseObject({ content: ContentBlocks.optional() }).optional(),
});

const ToolEnd = z.object({
  type: z.literal("tool_execution_end"),
  toolCallId: z.string(),
  result: z.looseObject({ content: ContentBlocks.optional() }).optional(),
  isError: z.boolean().optional(),
});

const AgentEnd = z.object({
  type: z.literal("agent_end"),
  messages: z.array(z.looseObject({ role: z.string(), content: ContentBlocks.optional() })),
});

/** Text blocks of a tool result/content array; non-text entries are dropped. */
const textBlocks = (content: z.infer<typeof ContentBlocks> | undefined): Array<{ type: "text"; text: string }> =>
  (content ?? [])
    .filter((c) => (c.type === undefined || c.type === "text") && typeof c.text === "string")
    .map((c) => ({ type: "text" as const, text: c.text! }));

/** Line-delimited JSON translator: feed raw stdout chunks, get session updates back. */
export class OmpJsonTranslator {
  private buf = "";
  private readonly toolNames = new Map<string, string>();
  /** toolCallId → a `tool_call` was emitted; later updates become `tool_call_update`. */
  private readonly announced = new Set<string>();
  /** Final assistant text (from the last `agent_end`) — the slash step's output. */
  private output: string | undefined;

  /** Ingests one raw stdout chunk (any split across NDJSON lines) and returns updates in order. */
  push(chunk: string): SessionUpdate[] {
    this.buf += chunk;
    const updates: SessionUpdate[] = [];
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      updates.push(...this.translateLine(line));
    }
    return updates;
  }

  /** Flushes a trailing partial line (process ended without a newline). */
  end(): SessionUpdate[] {
    const rest = this.buf;
    this.buf = "";
    return this.translateLine(rest);
  }

  /** Accumulated assistant text of the final turn — the equivalent of print-mode stdout. */
  result(): string | undefined {
    return this.output;
  }

  private translateLine(line: string): SessionUpdate[] {
    if (!line.trim()) return [];
    // Each event is validated independently; anything unrecognized or malformed is skipped —
    // omp emits many event kinds (session, turn_*, message_start/end, …) we do not render.
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      // Non-JSON line (banner/warning on stdout): keep the stream alive; it is not user output.
      return [];
    }
    const textDelta = TextDelta.safeParse(ev);
    if (textDelta.success) {
      const delta = textDelta.data.assistantMessageEvent.delta;
      return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } }];
    }
    // omp /plan thinks (and streams thinking) long before the final text; the UI renders thought
    // chunks as collapsible "Thinking" sections, matching prompt-step behavior.
    const thoughtDelta = ThoughtDelta.safeParse(ev);
    if (thoughtDelta.success) {
      const delta = thoughtDelta.data.assistantMessageEvent.delta;
      return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta } }];
    }
    const start = ToolStart.safeParse(ev);
    if (start.success) {
      const { toolCallId, toolName, intent, args } = start.data;
      this.toolNames.set(toolCallId, toolName);
      this.announced.add(toolCallId);
      return [{ sessionUpdate: "tool_call", toolCallId, title: intent ?? toolName, name: toolName, kind: "execute", status: "in_progress", rawInput: args }];
    }
    const update = ToolUpdate.safeParse(ev);
    if (update.success) {
      const { toolCallId, partialResult } = update.data;
      const content = textBlocks(partialResult?.content);
      return this.toolUpdate(toolCallId, { sessionUpdate: "tool_call_update", toolCallId, content });
    }
    const end = ToolEnd.safeParse(ev);
    if (end.success) {
      const { toolCallId, result, isError } = end.data;
      const content = textBlocks(result?.content);
      return this.toolUpdate(toolCallId, { sessionUpdate: "tool_call_update", toolCallId, status: isError ? "failed" : "completed", content });
    }
    const agentEnd = AgentEnd.safeParse(ev);
    if (agentEnd.success) {
      const assistant = [...agentEnd.data.messages].reverse().find((m) => m.role === "assistant");
      const text = textBlocks(assistant?.content).map((b) => b.text).join("");
      if (text) this.output = text;
      return [];
    }
    return [];
  }

  /** Wraps an update with a defensive `tool_call` if the call never announced. */
  private toolUpdate(toolCallId: string, update: SessionUpdate): SessionUpdate[] {
    if (this.announced.has(toolCallId)) return [update];
    this.announced.add(toolCallId);
    const name = this.toolNames.get(toolCallId);
    return [{ sessionUpdate: "tool_call", toolCallId, title: name ?? "tool", name, kind: "execute", status: "in_progress" }, update];
  }
}
