import type { StepStatus } from "@orch/protocol";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { linkSubagents, type StepView, type SubagentView, type ToolCallView } from "../runState";
import { Collapsible, StatusChip } from "../ui";
import { StatusIcon } from "./icons";
import { LongText } from "./LongText";
import { TranscriptItems } from "./Transcript";

/**
 * An agent's status, from the `task` call that spawned it (omp reports no per-agent end). Without a finished
 * call it follows the step: running while the step runs, else done, or cancelled with a failed/cancelled step.
 */
function subagentStatus(parent: ToolCallView | undefined, stepStatus: StepStatus): StepStatus {
  if (parent?.status === "completed") return "succeeded";
  if (parent?.status === "failed") return "failed";
  if (stepStatus === "running") return "running";
  return stepStatus === "failed" || stepStatus === "cancelled" ? "cancelled" : "succeeded";
}

/** What the agent did last: its latest tool call's intent or text line, else its task's first line. */
function latestActivity(agent: SubagentView): string {
  for (let i = agent.items.length - 1; i >= 0; i--) {
    const item = agent.items[i]!;
    if (item.kind === "tool") return agent.toolCalls[item.toolCallId]?.title ?? "";
    if (item.kind === "assistant") return item.text.trim().split("\n").at(-1) ?? "";
    if (item.kind === "thought") return "Thinking…";
  }
  return agent.task.trim().split("\n")[0] ?? "";
}

/** One line per agent spawned by `parent` (or unmatched, without one); clicking opens its transcript. */
export function SubagentRows({
  agents,
  parent,
  stepStatus,
  onOpen,
}: {
  agents: SubagentView[];
  parent: ToolCallView | undefined;
  stepStatus: StepStatus;
  onOpen?: (agentId: string) => void;
}) {
  const status = subagentStatus(parent, stepStatus);
  return (
    <ul className="agent-rows">
      {agents.map((a) => {
        const calls = Object.keys(a.toolCalls).length;
        const body = (
          <>
            <StatusIcon status={status} size={14} />
            <span className="agent-row-id mono">{a.agentId}</span>
            <span className="tag">{a.agent}</span>
            {a.model && <span className="tag mono agent-row-model">{a.model}</span>}
            <span className="agent-row-activity muted">{latestActivity(a)}</span>
            <span className="muted small agent-row-count">
              {calls} tool {calls === 1 ? "call" : "calls"}
            </span>
          </>
        );
        return (
          <li key={a.agentId}>
            {onOpen ? (
              <button type="button" className="agent-row" title={`Open ${a.agentId}'s transcript`} onClick={() => onOpen(a.agentId)}>
                {body}
                <ChevronRight size={14} aria-hidden className="agent-row-open" />
              </button>
            ) : (
              <div className="agent-row">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The transcript of the last agent of `path` (outermost first), shown in place of the step's: breadcrumb
 * back to the step (`onNavigate(0)`) or an outer agent (`onNavigate(depth)`), the agent's header with its
 * assignment collapsed, then its transcript with rows for the agents it spawned.
 */
export function SubagentTranscript({
  step,
  stepName,
  path,
  onNavigate,
  onOpenAgent,
}: {
  step: StepView;
  stepName: string;
  path: SubagentView[];
  onNavigate: (depth: number) => void;
  onOpenAgent: (agentId: string) => void;
}) {
  const links = useMemo(() => linkSubagents(step), [step]);
  const agent = path[path.length - 1]!;
  const status = subagentStatus(links.parentCall.get(agent.agentId), step.status);
  // The first user message is the assignment omp sent the agent: shown collapsed in the header instead.
  const first = agent.items[0];
  const assignment = first?.kind === "user" ? first.text : agent.task;
  const source = first?.kind === "user" ? { items: agent.items.slice(1), toolCalls: agent.toolCalls } : agent;
  const calls = Object.keys(agent.toolCalls).length;
  return (
    <>
      <nav className="step-header agent-crumbs" aria-label="Subagent path">
        <button type="button" className="btn small ghost" title="Back (Esc)" onClick={() => onNavigate(path.length - 1)}>
          <ArrowLeft size={14} aria-hidden /> Back
        </button>
        <ol className="agent-crumb-list">
          <li>
            <button type="button" className="link-btn" onClick={() => onNavigate(0)}>
              {stepName}
            </button>
          </li>
          {path.map((a, i) => (
            <li key={a.agentId}>
              <ChevronRight size={12} aria-hidden className="muted" />
              {i === path.length - 1 ? (
                <span className="mono" aria-current="page">
                  {a.agentId}
                </span>
              ) : (
                <button type="button" className="link-btn mono" onClick={() => onNavigate(i + 1)}>
                  {a.agentId}
                </button>
              )}
            </li>
          ))}
        </ol>
        <span className="grow" />
        <StatusIcon status={status} size={14} />
      </nav>
      <div className="agent-focus-head">
        <strong className="mono">{agent.agentId}</strong>
        <span className="tag">{agent.agent}</span>
        {agent.model && <span className="tag mono">{agent.model}</span>}
        <StatusChip status={status} />
        <span className="muted small">
          {calls} tool {calls === 1 ? "call" : "calls"}
        </span>
      </div>
      {assignment && (
        <Collapsible summary={<span className="muted">Assignment</span>} className="agent-assignment">
          <LongText text={assignment} markdown />
        </Collapsible>
      )}
      <div className="transcript">
        <TranscriptItems source={source} links={links} stepStatus={step.status} onOpenAgent={onOpenAgent} />
        {source.items.length === 0 && <p className="muted">No messages yet.</p>}
      </div>
    </>
  );
}
