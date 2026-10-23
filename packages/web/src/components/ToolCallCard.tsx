import { contentText, type ToolCallView } from "../runState";
import { Collapsible, toJson } from "../ui";

/** Text rendering of one ACP `ToolCallContent` entry. */
function toolContentText(c: unknown): string {
  const item = c as { type?: string; content?: unknown; path?: string; oldText?: string | null; newText?: string; terminalId?: string };
  switch (item.type) {
    case "content":
      return contentText(item.content);
    case "diff":
      return `--- ${item.path ?? ""}\n${item.oldText ? `${item.oldText}\n+++\n` : ""}${item.newText ?? ""}`;
    case "terminal":
      return `[terminal ${item.terminalId ?? ""}]`;
    default:
      return toJson(c);
  }
}

export function ToolCallCard({ call }: { call: ToolCallView }) {
  const status = call.status ?? "pending";
  const content = call.content.map(toolContentText).filter(Boolean).join("\n\n");
  const active = status === "pending" || status === "in_progress";
  return (
    <div className={`tool-card tool-${status}`}>
      <div className="tool-head">
        <span className="tag">{call.kind ?? "tool"}</span>
        <span className="tool-title">{call.title}</span>
        {call.name && call.name !== call.title && <span className="muted small mono">{call.name}</span>}
        <span className="grow" />
        <span className={`chip chip-tool-${status}`}>{status.replace("_", " ")}</span>
      </div>
      {call.locations.length > 0 && (
        <div className="mono small muted">
          {call.locations.map((l) => `${l.path}${l.line ? `:${l.line}` : ""}`).join(", ")}
        </div>
      )}
      {call.rawInput !== undefined && (
        <Collapsible summary="Input" className="small">
          <pre>{toJson(call.rawInput)}</pre>
        </Collapsible>
      )}
      {content && (
        // Live `task` progress arrives via tool_call_update content: show it expanded while running.
        <Collapsible key={active ? "active" : "done"} summary="Content" defaultOpen={active} className="small">
          <pre>{content}</pre>
        </Collapsible>
      )}
      {call.rawOutput !== undefined && (
        <Collapsible summary="Output" className="small">
          <pre>{toJson(call.rawOutput)}</pre>
        </Collapsible>
      )}
    </div>
  );
}
