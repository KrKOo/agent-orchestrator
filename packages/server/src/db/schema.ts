import type {
  FlowDefinition,
  FlowOrigin,
  InterventionChoice,
  RunGitHubInfo,
  RunnerCapabilities,
  RunOverrides,
  RunStatus,
  StepStatus,
  TaskEventKind,
  TaskIntegration,
  TaskSettings,
  TaskStatus,
  WorkspaceInfo,
} from "@orch/protocol";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const flows = sqliteTable("flows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  definition: text("definition", { mode: "json" }).$type<FlowDefinition>().notNull(),
  version: integer("version").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  /** Task whose manager created the flow; cleared when the user promotes it to a regular flow. */
  taskId: text("task_id"),
  origin: text("origin").$type<FlowOrigin>().notNull().default("user"),
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
    /** Set while a retried run is non-terminal: the step idx it restarts from (cleared on terminal). */
    resumeFrom: integer("resume_from"),
    /** Display name: set at creation, or agent-generated (`autoName`) once a runner reports `run.name`. */
    name: text("name"),
    /** The run asked its runner's model for a name; `name` stays null until the `run.name` event. */
    autoName: integer("auto_name", { mode: "boolean" }).notNull().default(false),
    /**
     * Set while a retried run resuming a `local_path` workspace past step 1 is non-terminal: the runner
     * that ran the previous attempt (it holds the worktree); only it may take the run (cleared on terminal).
     */
    resumeRunnerId: text("resume_runner_id"),
    /** Host workspace (path/branch/repo) reported by the runner once the run starts. */
    workspace: text("workspace", { mode: "json" }).$type<WorkspaceInfo>(),
    /** Task the run belongs to (its manager run or a child run the manager started). */
    taskId: text("task_id"),
    role: text("role").$type<"manager" | "worker">(),
    /** Task child runs: who answers interventions and permission requests ("Take over" sets `user`). */
    interventionHandler: text("intervention_handler").$type<"user" | "manager">(),
    /** Task child runs: workspace/push overrides sent with `job.assign`. */
    overrides: text("overrides", { mode: "json" }).$type<RunOverrides>(),
  },
  (t) => [
    index("runs_status_idx").on(t.status, t.createdAt),
    index("runs_flow_idx").on(t.flowId, t.createdAt),
    index("runs_task_idx").on(t.taskId, t.createdAt),
  ],
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

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").$type<TaskStatus>().notNull(),
  createdBy: text("created_by"),
  settings: text("settings", { mode: "json" }).$type<TaskSettings>().notNull(),
  /** Per repo: integration branch once created, final PR once opened. */
  integration: text("integration", { mode: "json" }).$type<TaskIntegration>().notNull(),
  /** Highest `task_messages.seq` the manager consumed (`manager.consumed`); later user/event rows are its inbox. */
  inboxAckedSeq: integer("inbox_acked_seq").notNull().default(0),
  /** Current (or last) manager run. */
  managerRunId: text("manager_run_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const taskMessages = sqliteTable(
  "task_messages",
  {
    taskId: text("task_id").notNull(),
    seq: integer("seq").notNull(),
    role: text("role").$type<"user" | "manager" | "event">().notNull(),
    text: text("text").notNull(),
    ts: integer("ts").notNull(),
    runId: text("run_id"),
    event: text("event").$type<TaskEventKind>(),
    choices: text("choices", { mode: "json" }).$type<InterventionChoice[]>(),
    choice: text("choice"),
    answerTo: integer("answer_to"),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.seq] })],
);
