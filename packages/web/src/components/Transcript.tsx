import type { StepStatus } from "@orch/protocol";
import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { useMemo } from "react";
import { groupToolRuns, linkSubagents, modelsSwitchText, type StepView, type SubagentLinks, type ToolCallView, type TranscriptSource } from "../runState";
import { Collapsible } from "../ui";
import { LongText } from "./LongText";
import { SubagentRows } from "./Subagents";
import { ToolCallCard } from "./ToolCallCard";

const PLAN_MARK: Record<string, typeof Circle> = { completed: CircleCheck, in_progress: CircleDot, pending: Circle };

/** `read ×4, grep ×3`: the tools of a folded run, most used first. */
function toolTally(calls: ToolCallView[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const name = c.name ?? c.kind ?? "tool";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(", ");
}

/**
 * One transcript (a step's main thread or a subagent's): messages, tool calls with runs of finished ones
 * folded, and under each `task` call a row per agent it spawned (`links`), which `onOpenAgent` opens.
 */
export function TranscriptItems({
  source,
  links,
  stepStatus,
  onOpenAgent,
}: {
  source: TranscriptSource;
  links: SubagentLinks;
  stepStatus: StepStatus;
  onOpenAgent?: (agentId: string) => void;
}) {
  const grouped = groupToolRuns(source.items, source.toolCalls, new Set(links.byToolCall.keys()));
  // Folding only regroups tool items, so the other items keep their ordinal as key (and their open state).
  let ordinal = 0;
  return grouped.map((item) => {
    switch (item.kind) {
      case "tool": {
        const call = source.toolCalls[item.toolCallId];
        if (!call) return null;
        const agents = links.byToolCall.get(call.toolCallId);
        return (
          <ToolCallCard
            key={`t:${call.toolCallId}`}
            call={call}
            agents={agents && <SubagentRows agents={agents} parent={call} stepStatus={stepStatus} onOpen={onOpenAgent} />}
          />
        );
      }
      case "toolGroup": {
        const calls = item.toolCallIds.flatMap((id) => source.toolCalls[id] ?? []);
        return (
          <Collapsible
            key={`g:${item.toolCallIds[0]}`}
            className="tool-group small"
            summary={
              <span className="tool-group-summary">
                <strong>{calls.length} tool calls</strong>
                <span className="muted"> · {toolTally(calls)}</span>
              </span>
            }
          >
            <div className="tool-group-body">
              {calls.map((c) => (
                <ToolCallCard key={c.toolCallId} call={c} />
              ))}
            </div>
          </Collapsible>
        );
      }
    }
    const key = `i:${ordinal++}`;
    switch (item.kind) {
      case "assistant":
        return <LongText key={key} className="msg-assistant" text={item.text} markdown />;
      case "thought":
        return (
          <Collapsible key={key} className="thought" summary={<span className="muted">Thinking</span>}>
            <div className="thought-text">{item.text}</div>
          </Collapsible>
        );
      case "user":
        return (
          <div key={key} className="msg-user">
            {item.text}
          </div>
        );
      case "iteration":
        return (
          <div key={key} className="iteration-divider">
            <span className="iteration-label">Iteration {item.n}</span>
          </div>
        );
      case "models":
        return (
          <div key={key} className="models-marker small muted" role="note">
            {modelsSwitchText(item.models, item.applied)}
          </div>
        );
      case "plan":
        return (
          <div key={key} className="plan">
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
          <Collapsible key={key} className="other-update small" summary={<span className="muted mono">{item.update.sessionUpdate}</span>}>
            <pre>{JSON.stringify(item.update, null, 2)}</pre>
          </Collapsible>
        );
    }
  });
}

/** One step's main transcript; agents no `task` call could be matched to are listed at its end. */
export function Transcript({ step, onOpenAgent }: { step: StepView; onOpenAgent?: (agentId: string) => void }) {
  const links = useMemo(() => linkSubagents(step), [step]);
  return (
    <div className="transcript">
      <TranscriptItems source={step} links={links} stepStatus={step.status} onOpenAgent={onOpenAgent} />
      {links.unlinked.length > 0 && (
        <section className="agent-unlinked">
          <h4>Subagents</h4>
          <SubagentRows agents={links.unlinked} parent={undefined} stepStatus={step.status} onOpen={onOpenAgent} />
        </section>
      )}
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
