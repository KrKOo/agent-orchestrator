// Pure reducer turning a run's event log into the view model rendered by RunView.
import { TERMINAL_STATUSES, type Finding, type InterventionSession, type RunEvent, type RunStatus, type StepStatus, type SubagentBlock, type WorkspaceInfo } from "@orch/protocol";

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
  | { kind: "iteration"; n: number }
  | { kind: "other"; update: { sessionUpdate: string; [k: string]: unknown } };

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

export interface InterventionView {
  requestId: string;
  stepId?: string;
  message: string;
  /** Sessions the user can chat with and their latest results. */
  sessions: InterventionSession[];
  /** Preselected session id. */
  session?: string;
  /** Why the last chat turn failed. */
  error?: string;
  /** Set on `ask` loop gates that can still repeat: repeat from `toStepId`, starting iteration `iteration` of `maxIterations`. */
  repeat?: { toStepId: string; iteration: number; maxIterations: number };
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
  /** Run name from the first `run.name` event (agent-generated naming); later ones are ignored, like the server. */
  name?: string;
  error?: string;
  workspace?: WorkspaceInfo;
  currentStepId?: string;
  steps: Record<string, StepView>;
  /** Step ids in the order their first event arrived (the run's execution order). */
  stepOrder: string[];
  findings: (Finding & { stepId?: string })[];
  permissions: PermissionView[];
  elicitations: ElicitationView[];
  interventions: InterventionView[];
  /** Per-loop current/max iteration, kept by `loop.repeat` and cleared when a retry rewinds past the loop. */
  loops: Record<string, { iteration: number; maxIterations: number }>;
  logs: LogLine[];
}

export const initialRunViewState: RunViewState = {
  lastSeq: 0,
  steps: {},
  stepOrder: [],
  findings: [],
  permissions: [],
  elicitations: [],
  interventions: [],
  loops: {},
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
  const known = key in state.steps;
  return {
    ...state,
    steps: { ...state.steps, [key]: fn(state.steps[key] ?? emptyStep) },
    stepOrder: known || key === NO_STEP ? state.stepOrder : [...state.stepOrder, key],
  };
}

/** Drops the attempt-scoped result of a step; its transcript stays (a retry appends to it). */
function resetAttempt(st: StepView, status: StepStatus): StepView {
  return { ...st, status, output: undefined, structured: undefined, error: undefined };
}

/** A retry reset `fromStepId` and every step after it to pending. */
function resetFrom(state: RunViewState, fromStepId: string): RunViewState {
  const idx = state.stepOrder.indexOf(fromStepId);
  if (idx < 0) return state;
  const steps = { ...state.steps };
  for (const id of state.stepOrder.slice(idx)) steps[id] = resetAttempt(steps[id]!, "pending");
  return { ...state, steps };
}

/**
 * Drops the loop counters of loops at or after the retry cursor. We don't know the definition here,
 * so we can't tell a loop from the body it contains — clearing every counter recorded after the
 * cursor start errs toward restarting them, which matches the runner (counters restart on retry).
 */
function resetLoopsFrom(state: RunViewState, fromStepId: string): RunViewState["loops"] {
  const idx = state.stepOrder.indexOf(fromStepId);
  const loops: RunViewState["loops"] = {};
  for (const [id, c] of Object.entries(state.loops)) {
    const stepIdx = state.stepOrder.indexOf(id);
    if (stepIdx >= 0 && idx >= 0 && stepIdx < idx) loops[id] = c;
  }
  return loops;
}

export function applyRunEvent(state: RunViewState, ev: RunEvent): RunViewState {
  if (ev.seq <= state.lastSeq) return state;
  const s: RunViewState = { ...state, lastSeq: ev.seq };
  switch (ev.type) {
    case "run.status": {
      // A retried run re-enters a non-terminal status: the previous attempt's error no longer applies.
      const error = TERMINAL_STATUSES.includes(ev.payload.status) ? (ev.payload.error ?? s.error) : undefined;
      const from = ev.payload.resumeFromStepId;
      // Retry rewinds loop steps too (the runner restarts their counters), so drop the stale badges.
      const loops = from === undefined ? s.loops : resetLoopsFrom(s, from);
      return {
        ...(from === undefined ? s : resetFrom(s, from)),
        loops,
        status: ev.payload.status,
        error,
        workspace: ev.payload.workspace ?? s.workspace,
      };
    }
    case "step.started":
      return withStep({ ...s, currentStepId: ev.stepId }, ev.stepId, (st) =>
        // Iteration ≥2: the step re-runs inside a loop body; the divider marks each pass in its transcript.
        ev.payload.iteration === undefined
          ? resetAttempt(st, "running")
          : { ...resetAttempt(st, "running"), items: [...st.items, { kind: "iteration", n: ev.payload.iteration }] },
      );
    case "run.name":
      return { ...s, name: s.name ?? ev.payload.name };
    case "step.finished":
      return withStep(s, ev.stepId, (st) => ({
        ...st,
        status: ev.payload.status,
        output: ev.payload.output,
        structured: ev.payload.structured,
        error: ev.payload.error,
      }));
    case "loop.repeat": {
      // The body steps repeat: back to pending for their next pass, transcripts kept (one per step).
      // The loop step itself keeps its finished state; RunView shows its `iteration/max` badge.
      // Loops nested in the body restart their count (as the runner does), so their badges go too.
      const loopStepId = ev.stepId ?? "";
      const steps = { ...s.steps };
      const loops = { ...s.loops };
      for (const id of ev.payload.stepIds) {
        const st = steps[id];
        if (st) steps[id] = resetAttempt(st, "pending");
        delete loops[id];
      }
      loops[loopStepId] = { iteration: ev.payload.iteration, maxIterations: ev.payload.maxIterations };
      return { ...s, steps, loops };
    }
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
    case "intervention.request":
      return {
        ...s,
        interventions: [...s.interventions, { ...ev.payload, stepId: ev.stepId, resolved: false }],
      };
    case "intervention.resolved":
      return {
        ...s,
        interventions: s.interventions.map((i) => (i.requestId === ev.payload.requestId ? { ...i, resolved: true } : i)),
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
  // Logs are independent of other state, so a batch (e.g. a replayed backlog with thousands of
  // shell output chunks) appends them in one copy instead of re-copying the array per line.
  const logs: LogLine[] = [];
  let next = state;
  for (const ev of events) {
    if (ev.seq <= next.lastSeq) continue;
    if (ev.type === "sandbox.log") {
      logs.push({ seq: ev.seq, stepId: ev.stepId, ...ev.payload });
      next = { ...next, lastSeq: ev.seq };
    } else {
      next = applyRunEvent(next, ev);
    }
  }
  return logs.length > 0 ? { ...next, logs: next.logs.concat(logs) } : next;
}
