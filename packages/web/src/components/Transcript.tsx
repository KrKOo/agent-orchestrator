import Markdown from "react-markdown";
import type { StepView } from "../runState";
import { Collapsible } from "../ui";
import { SubagentPanel } from "./SubagentPanel";
import { ToolCallCard } from "./ToolCallCard";

const PLAN_MARK: Record<string, string> = { completed: "☑", in_progress: "◐", pending: "☐" };

/** Renders one step's ACP session updates, subagents, and final output. */
export function Transcript({ step }: { step: StepView }) {
  return (
    <div className="transcript">
      {step.items.map((item, i) => {
        switch (item.kind) {
          case "assistant":
            return (
              <div key={i} className="msg-assistant markdown">
                <Markdown>{item.text}</Markdown>
              </div>
            );
          case "thought":
            return (
              <Collapsible key={i} className="thought" summary={<span className="muted">Thinking</span>}>
                <div className="thought-text">{item.text}</div>
              </Collapsible>
            );
          case "user":
            return (
              <div key={i} className="msg-user">
                {item.text}
              </div>
            );
          case "tool": {
            const call = step.toolCalls[item.toolCallId];
            return call ? <ToolCallCard key={i} call={call} /> : null;
          }
          case "plan":
            return (
              <div key={i} className="plan">
                <strong className="small">Plan</strong>
                <ul>
                  {item.entries.map((e, n) => (
                    <li key={n} className={`plan-${e.status}`}>
                      <span className="plan-mark">{PLAN_MARK[e.status] ?? "☐"}</span> {e.content}
                    </li>
                  ))}
                </ul>
              </div>
            );
          case "other":
            return (
              <div key={i} className="other-update mono small" title={JSON.stringify(item.update, null, 2)}>
                {JSON.stringify(item.update)}
              </div>
            );
        }
      })}
      <SubagentPanel agents={step.subagents} />
      {(step.output !== undefined || step.error) && (
        <div className={`step-result step-result-${step.status}`}>
          <div className="small muted">Step {step.status}</div>
          {step.error && <div className="error">{step.error}</div>}
          {step.output !== undefined && step.output !== "" && (
            <Collapsible summary="Output" defaultOpen={step.items.length === 0}>
              <pre>{step.output}</pre>
            </Collapsible>
          )}
          {step.structured !== undefined && (
            <Collapsible summary="Structured output">
              <pre>{JSON.stringify(step.structured, null, 2)}</pre>
            </Collapsible>
          )}
        </div>
      )}
    </div>
  );
}
