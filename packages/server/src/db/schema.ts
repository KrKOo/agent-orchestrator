import type { FlowDefinition, RunGitHubInfo, RunnerCapabilities, RunStatus, StepStatus } from "@orch/protocol";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const flows = sqliteTable("flows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  definition: text("definition", { mode: "json" }).$type<FlowDefinition>().notNull(),
  version: integer("version").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    flowVersion: integer("flow_version").notNull(),
    definition: text("definition", { mode: "json" }).$type<FlowDefinition>().notNull(),
    inputs: text("inputs", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    trust: text("trust").$type<"owner" | "untrusted">().notNull(),
    runnerId: text("runner_id"),
    createdBy: text("created_by"),
    triggerKind: text("trigger_kind").$type<"manual" | "github">().notNull(),
    dedupeKey: text("dedupe_key").unique(),
    github: text("github", { mode: "json" }).$type<RunGitHubInfo>(),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("runs_status_idx").on(t.status, t.createdAt), index("runs_flow_idx").on(t.flowId, t.createdAt)],
);

export const runSteps = sqliteTable(
  "run_steps",
  {
    runId: text("run_id").notNull(),
    stepId: text("step_id").notNull(),
    idx: integer("idx").notNull(),
    status: text("status").$type<StepStatus>().notNull(),
    output: text("output"),
    structured: text("structured", { mode: "json" }).$type<unknown>(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.stepId] })],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    runId: text("run_id").notNull(),
    seq: integer("seq").notNull(),
    ts: integer("ts").notNull(),
    stepId: text("step_id"),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export const findings = sqliteTable(
  "findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    stepId: text("step_id").notNull(),
    file: text("file").notNull(),
    line: integer("line").notNull(),
    endLine: integer("end_line"),
    severity: text("severity").$type<"error" | "warning" | "info">().notNull(),
    message: text("message").notNull(),
    ruleId: text("rule_id"),
  },
  (t) => [index("findings_run_idx").on(t.runId)],
);

export const runners = sqliteTable("runners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  ownerUserId: text("owner_user_id"),
  labels: text("labels", { mode: "json" }).$type<string[]>().notNull(),
  capabilities: text("capabilities", { mode: "json" }).$type<RunnerCapabilities>(),
  lastSeenAt: integer("last_seen_at"),
});

export const users = sqliteTable("users", {
  /** GitHub user id (decimal string). */
  id: text("id").primaryKey(),
  login: text("login").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  /** `X-GitHub-Delivery`. */
  id: text("id").primaryKey(),
  receivedAt: integer("received_at").notNull(),
});
