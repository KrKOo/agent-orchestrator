import type { StepView } from "../runState";
import { Collapsible } from "../ui";
import { LongText } from "./LongText";
import { SubagentPanel } from "./SubagentPanel";
import { ToolCallCard } from "./ToolCallCard";

const PLAN_MARK: Record<string, string> = { completed: "☑", in_progress: "◐", pending: "☐" };

/** Renders one step's ACP session updates and subagents. */
export function Transcript({ step }: { step: StepView }) {
  return (
    <div className="transcript">
      {step.items.map((item, i) => {
        switch (item.kind) {
          case "assistant":
            return <LongText key={i} className="msg-assistant" text={item.text} markdown />;
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
              <Collapsible
                key={i}
                className="other-update small"
                summary={<span className="muted mono">{item.update.sessionUpdate}</span>}
              >
                <pre>{JSON.stringify(item.update, null, 2)}</pre>
              </Collapsible>
            );
        }
      })}
      <SubagentPanel agents={step.subagents} />
    </div>
  );
}

/** A finished step's error and outputs, always expanded, labelled with the template reference later steps use. */
export function StepResult({ step, stepId, markdown }: { step: StepView; stepId: string; markdown: boolean }) {
  const hasOutput = step.output !== undefined && step.output !== "";
  if (!step.error && !hasOutput && step.structured === undefined) return null;
  return (
    <div className="step-result">
      {step.error && <div className="step-error">{step.error}</div>}
      {hasOutput && (
        <section className="output-card">
          <div className="output-card-head">
            <strong>Output</strong>
            <code className="small">{`{{steps.${stepId}.output}}`}</code>
          </div>
          <LongText className={markdown ? "output-card-body" : "output-card-body mono"} text={step.output!} markdown={markdown} />
        </section>
      )}
      {step.structured !== undefined && (
        <section className="output-card">
          <div className="output-card-head">
            <strong>Structured output</strong>
            <code className="small">{`{{steps.${stepId}.structured}}`}</code>
          </div>
          <pre className="output-card-body">{JSON.stringify(step.structured, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
