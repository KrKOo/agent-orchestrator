/** Stands in for `omp -p --mode json` in runJob tests: emits NDJSON events like real omp. */
const text = process.argv[2] ?? "";

// Loaded as a script by `bun <file>`; the export marks it as a module so top-level await typechecks.
export {};

// omp's startup `readPipedInput` phase consumes piped stdin until EOF; mirror that so a caller
// that keeps the pipe open reproduces the real hang instead of a pass it shouldn't get.
await (async () => {
  for await (const _ of Bun.stdin.stream()) void _;
})();

const emit = (obj: unknown) => console.log(JSON.stringify(obj));
emit({ type: "session", version: 3, id: "fake" });
if (text.includes("fail")) {
  process.stderr.write("boom\n");
  process.exit(3);
}
if (text.includes("tool")) {
  // Tool activity: streamed as tool_execution_* events, rendered as tool cards by the UI.
  const id = "tool_1";
  emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "echo hi" }, intent: "Running echo" });
  emit({ type: "tool_execution_update", toolCallId: id, toolName: "bash", partialResult: { content: [{ type: "text", text: "hi\n" }] } });
  emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }] }, isError: false });
}
if (text.includes("think")) {
  // Thinking deltas stream as collapsible "Thinking" sections, like real omp's extended thinking.
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "pondering " } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "the request" } });
}
// The answer streams as text deltas, then a final agent_end carries the whole assistant message.
for (const part of ["print:", text, "\n"]) {
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: part } });
}
emit({
  type: "agent_end",
  messages: [
    { role: "user", content: [{ type: "text", text }] },
    { role: "assistant", content: [{ type: "text", text: `print:${text}\n` }] },
  ],
});
