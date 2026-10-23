import type { SubagentBlock } from "@orch/protocol";
import Markdown from "react-markdown";
import type { SubagentView } from "../runState";
import { Collapsible, toJson } from "../ui";

function Block({ block }: { block: SubagentBlock }) {
  switch (block.type) {
    case "text":
      return (
        <div className="markdown">
          <Markdown>{block.text}</Markdown>
        </div>
      );
    case "thinking":
      return <div className="thought-text">{block.text}</div>;
    case "toolCall":
      return (
        <Collapsible
          className="small"
          summary={
            <>
              <span className="mono">{block.name}</span>
              {block.intent && <span className="muted"> — {block.intent}</span>}
            </>
          }
        >
          <pre>{toJson(block.arguments)}</pre>
        </Collapsible>
      );
    case "toolResult":
      return (
        <Collapsible className="small" summary={<span className="muted">result</span>}>
          <pre>{block.text}</pre>
        </Collapsible>
      );
  }
}

/** One collapsible section per subagent spawned during a step (from session JSONL sidecars). */
export function SubagentPanel({ agents }: { agents: SubagentView[] }) {
  if (agents.length === 0) return null;
  return (
    <div className="subagents">
      <h4>Subagents ({agents.length})</h4>
      {agents.map((a) => (
        <Collapsible
          key={a.agentId}
          className="subagent"
          summary={
            <span className="subagent-head">
              <strong>{a.agent}</strong>
              {a.model && <span className="tag mono">{a.model}</span>}
              <span className="muted">{a.task.slice(0, 120)}</span>
              <span className="muted small">· {a.messages.length} msgs</span>
            </span>
          }
        >
          {a.messages.length === 0 && <p className="muted small">No messages yet.</p>}
          {a.messages.map((m) => (
            <div key={m.seq} className={`sub-msg sub-${m.role}`}>
              <span className="sub-role">{m.role}</span>
              <div className="sub-blocks">
                {m.blocks.map((b, i) => (
                  <Block key={i} block={b} />
                ))}
              </div>
            </div>
          ))}
        </Collapsible>
      ))}
    </div>
  );
}
