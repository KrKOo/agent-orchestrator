import { z } from "zod";
import { InterventionAction } from "./flow";

/** `awaiting_input`: an intervention step is paused for the user (the runner still holds the run). */
export const RUN_STATUSES = ["queued", "awaiting_approval", "assigned", "running", "awaiting_input", "succeeded", "failed", "cancelled"] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;
export const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
/** Terminal statuses a run can be retried from (same run, from a step cursor). */
export const RETRYABLE_STATUSES: readonly RunStatus[] = ["failed", "cancelled"];

export const StepStatus = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
export type StepStatus = z.infer<typeof StepStatus>;

export const Finding = z.object({
  file: z.string().min(1),
  line: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().max(2000),
  ruleId: z.string().max(100).optional(),
});
export type Finding = z.infer<typeof Finding>;

/** Raw ACP `SessionUpdate`; rendered by the UI as-is. */
export const SessionUpdate = z.looseObject({ sessionUpdate: z.string() });
export type SessionUpdate = { sessionUpdate: string; [k: string]: unknown };

export const SubagentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({
    type: z.literal("toolCall"),
    id: z.string(),
    name: z.string(),
    intent: z.string().optional(),
    arguments: z.unknown(),
  }),
  z.object({ type: z.literal("toolResult"), text: z.string() }),
]);
export type SubagentBlock = z.infer<typeof SubagentBlock>;

const PermissionOption = z.object({ optionId: z.string(), name: z.string(), kind: z.string() });

/** An agent session of the run that an intervention can chat with, and its latest result. */
export const InterventionSession = z.object({ id: z.string(), label: z.string(), output: z.string() });
export type InterventionSession = z.infer<typeof InterventionSession>;

const base = {
  runId: z.string(),
  seq: z.number().int().min(1),
  ts: z.number(),
  stepId: z.string().optional(),
};

export const RunEvent = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("run.status"),
    payload: z.object({
      status: RunStatus,
      error: z.string().optional(),
      /** Set on `running`: host workspace (worktree or direct path), orchestrator branch, and GitHub origin repo if any. */
      workspace: z.object({ path: z.string(), branch: z.string().optional(), repo: z.string().optional() }).optional(),
      /** Set on the server's retry `queued` event: steps from this one on were reset to pending. */
      resumeFromStepId: z.string().optional(),
    }),
  }),
  z.object({ ...base, type: z.literal("step.started"), payload: z.object({}) }),
  z.object({
    ...base,
    type: z.literal("run.name"),
    payload: z.object({ name: z.string().min(1).max(200) }),
  }),
  z.object({
    ...base,
    type: z.literal("step.finished"),
    payload: z.object({
      status: z.enum(["succeeded", "failed", "cancelled"]),
      output: z.string().optional(),
      structured: z.unknown().optional(),
      error: z.string().optional(),
    }),
  }),
  z.object({ ...base, type: z.literal("acp.update"), payload: z.object({ update: SessionUpdate }) }),
  z.object({
    ...base,
    type: z.literal("acp.permission_request"),
    payload: z.object({ requestId: z.string(), toolCall: z.unknown(), options: z.array(PermissionOption) }),
  }),
  z.object({
    ...base,
    type: z.literal("acp.permission_resolved"),
    payload: z.object({ requestId: z.string(), optionId: z.string().nullable() }),
  }),
  z.object({
    ...base,
    type: z.literal("acp.elicitation_request"),
    payload: z.object({ requestId: z.string(), message: z.string(), requestedSchema: z.unknown() }),
  }),
  z.object({
    ...base,
    type: z.literal("acp.elicitation_resolved"),
    payload: z.object({ requestId: z.string(), action: z.enum(["accept", "decline", "cancel"]) }),
  }),
  z.object({
    ...base,
    type: z.literal("intervention.request"),
    payload: z.object({
      requestId: z.string(),
      message: z.string(),
      /** Sessions the user can chat with, in the order they were opened. */
      sessions: z.array(InterventionSession),
      /** Preselected session: the one the user last chatted with, else the previous step's. */
      session: z.string().optional(),
      /** Why the last chat turn failed. */
      error: z.string().optional(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("intervention.resolved"),
    payload: z.object({ requestId: z.string(), action: InterventionAction }),
  }),
  z.object({
    ...base,
    type: z.literal("sandbox.log"),
    payload: z.object({ stream: z.enum(["stdout", "stderr"]), text: z.string() }),
  }),
  z.object({ ...base, type: z.literal("finding"), payload: Finding }),
  z.object({
    ...base,
    type: z.literal("subagent.started"),
    payload: z.object({ agentId: z.string(), agent: z.string(), task: z.string(), model: z.string().nullable() }),
  }),
  z.object({
    ...base,
    type: z.literal("subagent.message"),
    payload: z.object({
      agentId: z.string(),
      role: z.enum(["user", "assistant", "toolResult"]),
      blocks: z.array(SubagentBlock),
    }),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];
export type RunEventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;
/** Event before the outbox assigns `seq`. */
export type RunEventDraft = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "seq"> : never) : never;
