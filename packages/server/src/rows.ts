// DB row → REST shape mappers (`@orch/protocol` api.ts).
import type { FindingRow, FlowRow, RunEvent, RunRow, StepRow } from "@orch/protocol";
import type { schema } from "./db";

export function flowRow(r: typeof schema.flows.$inferSelect): FlowRow {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    definition: r.definition,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
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
    github: r.github,
    error: r.error,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    workspace: r.workspace ?? null,
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
