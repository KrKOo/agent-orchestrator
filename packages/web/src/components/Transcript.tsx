import { Circle, CircleCheck, CircleDot } from "lucide-react";
import type { StepView } from "../runState";
import { Collapsible } from "../ui";
import { LongText } from "./LongText";
import { SubagentPanel } from "./SubagentPanel";
import { ToolCallCard } from "./ToolCallCard";

const PLAN_MARK: Record<string, typeof Circle> = { completed: CircleCheck, in_progress: CircleDot, pending: Circle };

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
          case "iteration":
            return (
              <div key={i} className="iteration-divider">
                <span className="iteration-label">Iteration {item.n}</span>
              </div>
            );
          case "plan":
            return (
              <div key={i} className="plan">
                <strong className="small">Plan</strong>
                <ul>
                  {item.entries.map((e, n) => {
                    const Mark = PLAN_MARK[e.status] ?? Circle;
                    return (
                      <li key={n} className={`plan-${e.status}`}>
                        <span className="plan-mark">
                          <Mark size={12} aria-hidden />
                        </span> {e.content}
                      </li>
                    );
                  })}
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

/**
 * A finished step's error and outputs, always expanded, labelled with the template reference later steps use.
 * `stepId` is omitted for steps later steps cannot reference (loop and condition steps), which then show no reference.
 * `gate`: the request of an intervention step, whose pick shows as `Chose: <label>`.
 */
export function StepResult({ step, stepId, markdown, mono, gate }: { step: StepView; stepId?: string; markdown: boolean; mono?: boolean; gate?: { resolved: boolean; choice?: string; choices?: { id: string; label: string }[] } }) {
  const hasOutput = step.output !== undefined && step.output !== "";
  if (!step.error && !hasOutput && step.structured === undefined && !(gate?.resolved && gate.choice)) return null;
  return (
    <div className="step-result">
      {step.error && <div className="step-error">{step.error}</div>}
      {gate?.resolved && gate.choice && (
        <div className="gate-choice small">
          Chose: <strong>{gate.choices?.find((c) => c.id === gate.choice)?.label ?? gate.choice}</strong>
        </div>
      )}
      {hasOutput && (
        <section className="output-card">
          <div className="output-card-head">
            <strong>Output</strong>
            {stepId !== undefined && <code className="small">{`{{steps.${stepId}.output}}`}</code>}
          </div>
          <LongText className={mono || !markdown ? "output-card-body mono" : "output-card-body"} text={step.output!} markdown={markdown} />
        </section>
      )}
      {step.structured !== undefined && (
        <section className="output-card">
          <div className="output-card-head">
            <strong>Structured output</strong>
            {/* A gate's only structured value is its pick. */}
            {stepId !== undefined && <code className="small">{gate ? `{{steps.${stepId}.structured.choice}}` : `{{steps.${stepId}.structured}}`}</code>}
          </div>
          <pre className="output-card-body">{JSON.stringify(step.structured, null, 2)}</pre>
        </section>
      )}
    </div>
  );
}
