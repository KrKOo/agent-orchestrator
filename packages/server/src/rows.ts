// DB row → REST shape mappers (`@orch/protocol` api.ts).
import type { FindingRow, FlowRow, RunEvent, RunRow, StepRow, TaskMessage, TaskRow } from "@orch/protocol";
import type { schema } from "./db";

export function flowRow(r: typeof schema.flows.$inferSelect): FlowRow {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    definition: r.definition,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    origin: r.origin,
    taskId: r.taskId,
  };
}

export function runRow(r: typeof schema.runs.$inferSelect): RunRow {
  return {
    id: r.id,
    flowId: r.flowId,
    flowName: r.definition.name,
    flowVersion: r.flowVersion,
    definition: r.definition,
    inputs: r.inputs,
    status: r.status,
    trust: r.trust,
    runnerId: r.runnerId,
    createdBy: r.createdBy,
    triggerKind: r.triggerKind,
    name: r.name,
    autoName: r.autoName,
    github: r.github,
    error: r.error,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    workspace: r.workspace ?? null,
    taskId: r.taskId,
    role: r.role,
    interventionHandler: r.interventionHandler,
  };
}

/** `GET /api/tasks` row; `settings`/`integration` are stored JSON. */
export function taskRow(r: typeof schema.tasks.$inferSelect): TaskRow {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    createdBy: r.createdBy,
    settings: r.settings,
    integration: r.integration,
    managerRunId: r.managerRunId,
    inboxAckedSeq: r.inboxAckedSeq,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** One chat-log/inbox row; only the optionals a row carries are present (omit-null convention). */
export function taskMessageRow(r: typeof schema.taskMessages.$inferSelect): TaskMessage {
  return {
    taskId: r.taskId,
    seq: r.seq,
    role: r.role,
    text: r.text,
    ts: r.ts,
    ...(r.runId === null ? {} : { runId: r.runId }),
    ...(r.event === null ? {} : { event: r.event }),
    ...(r.choices === null ? {} : { choices: r.choices }),
    ...(r.choice === null ? {} : { choice: r.choice }),
    ...(r.answerTo === null ? {} : { answerTo: r.answerTo }),
  };
}

export function stepRow(r: typeof schema.runSteps.$inferSelect): StepRow {
  return {
    runId: r.runId,
    stepId: r.stepId,
    idx: r.idx,
    status: r.status,
    output: r.output,
    structured: r.structured ?? null,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

export function findingRow(r: typeof schema.findings.$inferSelect): FindingRow {
  return {
    id: r.id,
    runId: r.runId,
    stepId: r.stepId,
    file: r.file,
    line: r.line,
    ...(r.endLine === null ? {} : { endLine: r.endLine }),
    severity: r.severity,
    message: r.message,
    ...(r.ruleId === null ? {} : { ruleId: r.ruleId }),
  };
}

export function eventRow(r: typeof schema.runEvents.$inferSelect): RunEvent {
  return {
    runId: r.runId,
    seq: r.seq,
    ts: r.ts,
    ...(r.stepId === null ? {} : { stepId: r.stepId }),
    type: r.type,
    payload: r.payload,
  } as RunEvent;
}
