// Pure reducer turning a run's event log into the view model rendered by RunView.
import type { Finding, RunEvent, RunStatus, StepStatus, SubagentBlock } from "@orch/protocol";

export interface ToolCallView {
  toolCallId: string;
  title: string;
  name?: string;
  kind?: string;
  status?: string;
  content: unknown[];
  locations: { path: string; line?: number | null }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEntryView {
  content: string;
  priority?: string;
  status: string;
}

export type TranscriptItem =
  | { kind: "assistant"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "user"; text: string }
  | { kind: "tool"; toolCallId: string }
  | { kind: "plan"; entries: PlanEntryView[] }
  | { kind: "other"; update: unknown };

export interface SubagentMessageView {
  seq: number;
  role: "user" | "assistant" | "toolResult";
  blocks: SubagentBlock[];
}

export interface SubagentView {
  agentId: string;
  agent: string;
  task: string;
  model: string | null;
  messages: SubagentMessageView[];
}

export interface StepView {
  status: StepStatus;
  output?: string;
  structured?: unknown;
  error?: string;
  items: TranscriptItem[];
  toolCalls: Record<string, ToolCallView>;
  subagents: SubagentView[];
}

export interface PermissionView {
  requestId: string;
  stepId?: string;
  toolCall: unknown;
  options: { optionId: string; name: string; kind: string }[];
  resolved: boolean;
}

export interface ElicitationView {
  requestId: string;
  stepId?: string;
  message: string;
  requestedSchema: unknown;
  resolved: boolean;
}

export interface LogLine {
  seq: number;
  stepId?: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface RunViewState {
  lastSeq: number;
  status?: RunStatus;
  error?: string;
  workspace?: { path: string; branch?: string };
  currentStepId?: string;
  steps: Record<string, StepView>;
  findings: (Finding & { stepId?: string })[];
  permissions: PermissionView[];
  elicitations: ElicitationView[];
  logs: LogLine[];
}

export const initialRunViewState: RunViewState = {
  lastSeq: 0,
  steps: {},
  findings: [],
  permissions: [],
  elicitations: [],
  logs: [],
};

const NO_STEP = "";

const emptyStep: StepView = { status: "pending", items: [], toolCalls: {}, subagents: [] };

/** Text of an ACP `ContentBlock` (non-text blocks render as a short placeholder). */
export function contentText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const b = block as { type?: string; text?: string; uri?: string; resource?: { uri?: string; text?: string } };
  if (b.type === "text") return b.text ?? "";
  if (b.type === "resource_link") return `[${b.uri ?? "resource"}]`;
  if (b.type === "resource") return b.resource?.text ?? `[${b.resource?.uri ?? "resource"}]`;
  return `[${b.type ?? "content"}]`;
}

/** Fields of ACP `tool_call` / `tool_call_update` (all but the id optional and nullable on updates). */
interface AcpToolCallFields {
  sessionUpdate: string;
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: unknown[] | null;
  locations?: ToolCallView["locations"] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  [k: string]: unknown;
}

function applyUpdate(step: StepView, update: { sessionUpdate: string; [k: string]: unknown }): StepView {
  const items = step.items;
  const last = items[items.length - 1];
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      const kind =
        update.sessionUpdate === "agent_message_chunk"
          ? "assistant"
          : update.sessionUpdate === "agent_thought_chunk"
            ? "thought"
            : "user";
      const text = contentText(update.content);
      if (last && last.kind === kind) {
        return { ...step, items: [...items.slice(0, -1), { kind, text: last.text + text }] };
      }
      return { ...step, items: [...items, { kind, text }] };
    }
    case "tool_call":
    case "tool_call_update": {
      const u = update as AcpToolCallFields;
      const prev = step.toolCalls[u.toolCallId];
      const next: ToolCallView = {
        toolCallId: u.toolCallId,
        title: u.title ?? prev?.title ?? u.toolCallId,
        name: u.name ?? prev?.name,
        kind: u.kind ?? prev?.kind,
        status: u.status ?? prev?.status,
        content: u.content ?? prev?.content ?? [],
        locations: u.locations ?? prev?.locations ?? [],
        rawInput: "rawInput" in u ? u.rawInput : prev?.rawInput,
        rawOutput: "rawOutput" in u ? u.rawOutput : prev?.rawOutput,
      };
      const toolCalls = { ...step.toolCalls, [u.toolCallId]: next };
      return prev
        ? { ...step, toolCalls }
        : { ...step, toolCalls, items: [...items, { kind: "tool", toolCallId: u.toolCallId }] };
    }
    case "plan": {
      // Each plan update is the complete plan: replace the step's plan in place.
      const entries = (update.entries as PlanEntryView[] | undefined) ?? [];
      const idx = items.findIndex((i) => i.kind === "plan");
      if (idx < 0) return { ...step, items: [...items, { kind: "plan", entries }] };
      const copy = items.slice();
      copy[idx] = { kind: "plan", entries };
      return { ...step, items: copy };
    }
    default:
      return { ...step, items: [...items, { kind: "other", update }] };
  }
}

function withStep(state: RunViewState, stepId: string | undefined, fn: (s: StepView) => StepView): RunViewState {
  const key = stepId ?? NO_STEP;
  return { ...state, steps: { ...state.steps, [key]: fn(state.steps[key] ?? emptyStep) } };
}

export function applyRunEvent(state: RunViewState, ev: RunEvent): RunViewState {
  if (ev.seq <= state.lastSeq) return state;
  const s: RunViewState = { ...state, lastSeq: ev.seq };
  switch (ev.type) {
    case "run.status":
      return {
        ...s,
        status: ev.payload.status,
        error: ev.payload.error ?? s.error,
        workspace: ev.payload.workspace ?? s.workspace,
      };
    case "step.started":
      return withStep({ ...s, currentStepId: ev.stepId }, ev.stepId, (st) => ({ ...st, status: "running" }));
    case "step.finished":
      return withStep(s, ev.stepId, (st) => ({
        ...st,
        status: ev.payload.status,
        output: ev.payload.output,
        structured: ev.payload.structured,
        error: ev.payload.error,
      }));
    case "acp.update":
      return withStep(s, ev.stepId, (st) => applyUpdate(st, ev.payload.update));
    case "acp.permission_request":
      return {
        ...s,
        permissions: [...s.permissions, { ...ev.payload, stepId: ev.stepId, resolved: false }],
      };
    case "acp.permission_resolved":
      return {
        ...s,
        permissions: s.permissions.map((p) => (p.requestId === ev.payload.requestId ? { ...p, resolved: true } : p)),
      };
    case "acp.elicitation_request":
      return {
        ...s,
        elicitations: [...s.elicitations, { ...ev.payload, stepId: ev.stepId, resolved: false }],
      };
    case "acp.elicitation_resolved":
      return {
        ...s,
        elicitations: s.elicitations.map((e) => (e.requestId === ev.payload.requestId ? { ...e, resolved: true } : e)),
      };
    case "sandbox.log":
      return { ...s, logs: [...s.logs, { seq: ev.seq, stepId: ev.stepId, ...ev.payload }] };
    case "finding":
      return { ...s, findings: [...s.findings, { ...ev.payload, stepId: ev.stepId }] };
    case "subagent.started":
      return withStep(s, ev.stepId, (st) => {
        const existing = st.subagents.find((a) => a.agentId === ev.payload.agentId);
        if (existing) {
          return {
            ...st,
            subagents: st.subagents.map((a) => (a === existing ? { ...a, ...ev.payload, messages: a.messages } : a)),
          };
        }
        return { ...st, subagents: [...st.subagents, { ...ev.payload, messages: [] }] };
      });
    case "subagent.message":
      return withStep(s, ev.stepId, (st) => {
        const msg: SubagentMessageView = { seq: ev.seq, role: ev.payload.role, blocks: ev.payload.blocks };
        const existing = st.subagents.find((a) => a.agentId === ev.payload.agentId);
        if (!existing) {
          const placeholder: SubagentView = {
            agentId: ev.payload.agentId,
            agent: ev.payload.agentId,
            task: "",
            model: null,
            messages: [msg],
          };
          return { ...st, subagents: [...st.subagents, placeholder] };
        }
        return {
          ...st,
          subagents: st.subagents.map((a) => (a === existing ? { ...a, messages: [...a.messages, msg] } : a)),
        };
      });
  }
}

export function applyRunEvents(state: RunViewState, events: RunEvent[]): RunViewState {
  return events.reduce(applyRunEvent, state);
}
