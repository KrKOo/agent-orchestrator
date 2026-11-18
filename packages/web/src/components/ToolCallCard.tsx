import type { ReactNode } from "react";
import { contentText, type ToolCallView } from "../runState";
import { StatusIcon } from "./icons";
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

/** `agents`: rows of the subagents a `task` call spawned, shown under its head in place of its live progress. */
export function ToolCallCard({ call, agents }: { call: ToolCallView; agents?: ReactNode }) {
  const status = call.status ?? "pending";
  const content = call.content.map(toolContentText).filter(Boolean).join("\n\n");
  const active = status === "pending" || status === "in_progress";
  const openContent = active && !agents;
  return (
    <div className={`tool-card tool-${status}`}>
      <div className="tool-head">
        <span className="tag">{call.kind ?? "tool"}</span>
        <span className="tool-title">{call.title}</span>
        {call.name && call.name !== call.title && call.name !== call.kind && <span className="muted small mono">{call.name}</span>}
        <span className="grow" />
        <StatusIcon status={status === "pending" || status === "in_progress" ? "running" : status === "completed" ? "succeeded" : status === "failed" ? "failed" : "pending"} size={14} />
        <span className={`chip chip-tool-${status}`}>{status.replace("_", " ")}</span>
      </div>
      {call.locations.length > 0 && (
        <div className="mono small muted">
          {call.locations.map((l) => `${l.path}${l.line ? `:${l.line}` : ""}`).join(", ")}
        </div>
      )}
      {agents}
      {call.rawInput !== undefined && (
        <Collapsible summary="Input" className="small">
          <pre>{toJson(call.rawInput)}</pre>
        </Collapsible>
      )}
      {content && (
        // Live `task` progress arrives via tool_call_update content: show it expanded while running, unless
        // the agent rows already show it.
        <Collapsible key={openContent ? "active" : "done"} summary="Content" defaultOpen={openContent} className="small">
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
