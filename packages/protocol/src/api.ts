// REST response shapes shared by the server (`/api/*`) and the web UI.
// Timestamps are epoch milliseconds.
import { z } from "zod";
import { RunEvent, type Finding, RunStatus, type StepStatus } from "./events";
import { type FlowDefinition, HarnessModels } from "./flow";
import { TaskIntegration, TaskMessage, TaskSettings, TaskStatus, TASK_MESSAGE_MAX, TASK_TITLE_MAX } from "./task";
import type { CatalogEntry, ModelEntry, RunnerCapabilities } from "./wire";

/** `user`: written in the UI; `manager`: created by a task's manager (`taskId` set); `builtin`: shipped. */
export type FlowOrigin = "user" | "manager" | "builtin";

export interface FlowRow {
  id: string;
  name: string;
  version: number;
  definition: FlowDefinition;
  createdAt: number;
  updatedAt: number;
  origin: FlowOrigin;
  /** The task whose manager created the flow; null for user flows (and manager flows the user promoted). */
  taskId: string | null;
}

export interface RunGitHubInfo {
  installationId?: number;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  checkRunId?: number;
}

/** Where a run's code lives: host workspace path, orchestrator branch, GitHub origin repo. */
export interface WorkspaceInfo {
  path: string;
  branch?: string;
  repo?: string;
}

export interface RunRow {
  id: string;
  flowId: string;
  flowName: string;
  flowVersion: number;
  definition: FlowDefinition;
  inputs: Record<string, unknown>;
  status: RunStatus;
  trust: "owner" | "untrusted";
  runnerId: string | null;
  createdBy: string | null;
  triggerKind: "manual" | "github";
  /** Display name: set at creation, or agent-generated from the inputs (`autoName`) once assigned. */
  name: string | null;
  /** The run asked its runner's model for a name; `name` stays null until it reports one. */
  autoName: boolean;
  github: RunGitHubInfo | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Host workspace (worktree or direct path) the runner prepared, set once the run starts. */
  workspace: WorkspaceInfo | null;
  /** The task the run belongs to: its manager run, or a child run the manager started. */
  taskId: string | null;
  role: "manager" | "worker" | null;
  /** Task child runs: who answers the run's interventions and permission requests. */
  interventionHandler: "user" | "manager" | null;
}

/** `GET /api/runs` returns at most this many rows per page; a full page means there may be more. */
export const RUNS_PAGE_SIZE = 200;

/** Paging cursor for `GET /api/runs?before=`: the last row's sort key, `<createdAt>:<id>`. */
export function runsCursor(row: Pick<RunRow, "createdAt" | "id">): string {
  return `${row.createdAt}:${row.id}`;
}

/**
 * `GET /api/runs` query: `flowId`, `status` (comma list of run statuses), `before` (a `runsCursor`), `q`
 * (case-insensitive substring of the run name or id), `taskId`, and `handler` (`user`: runs whose requests the
 * user answers, i.e. not handled by a task manager, plus every `awaiting_approval` run, since only a person
 * approves; `manager`: runs whose requests a task manager answers). Empty values mean "no filter".
 */
export const RunsQuery = z.object({
  flowId: z.string().optional(),
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : []))
    .pipe(z.array(RunStatus))
    .transform((list) => (list.length ? list : undefined)),
  before: z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return undefined;
      const m = /^(\d+):(.+)$/.exec(s);
      if (!m) {
        ctx.addIssue({ code: "custom", message: "expected <createdAt>:<id>" });
        return z.NEVER;
      }
      return { createdAt: Number(m[1]), id: m[2]! };
    }),
  q: z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined),
  taskId: z
    .string()
    .optional()
    .transform((s) => s || undefined),
  handler: z
    .enum(["user", "manager", ""])
    .optional()
    .transform((s) => s || undefined),
});
export type RunsQuery = z.infer<typeof RunsQuery>;

/** `PUT /api/runs/:id/handler`: hand a task child run's requests to the user ("Take over") or back to the manager. */
export const SetRunHandlerBody = z.object({ handler: z.enum(["user", "manager"]) });
export type SetRunHandlerBody = z.infer<typeof SetRunHandlerBody>;

/** `PUT /api/runs/:id/models`: the run's new harness models (all roles; replaces the previous set). */
export const SetRunModelsBody = HarnessModels;
export type SetRunModelsBody = z.infer<typeof SetRunModelsBody>;

export interface StepRow {
  runId: string;
  stepId: string;
  idx: number;
  status: StepStatus;
  output: string | null;
  structured: unknown;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface FindingRow extends Finding {
  id: number;
  runId: string;
  stepId: string;
}

export interface RunDetail {
  run: RunRow;
  steps: StepRow[];
  findings: FindingRow[];
}

export interface RunnerRow {
  id: string;
  name: string;
  labels: string[];
  ownerUserId: string | null;
  capabilities: RunnerCapabilities | null;
  lastSeenAt: number | null;
  online: boolean;
  runningJobs: number;
}

export interface CatalogItem extends CatalogEntry {
  runnerIds: string[];
}

export interface Catalog {
  skills: CatalogItem[];
  commands: CatalogItem[];
  /** Gateway models of online runners, merged by id. */
  models: ModelEntry[];
}

/** Error body: `{error}` for single failures, `{errors}` for validation failures. */
export interface ApiError {
  error?: string;
  errors?: string[];
}

/** `GET /api/me`. With `authMode: "none"` there is no user. */
export interface MeResponse {
  authMode: "none" | "github";
  user: { id: string; login: string } | null;
}

/** Per-browser theme override; the server reads it when serving `/theme.css`. Absent = server default. */
export const THEME_COOKIE = "orch_theme";

/** `GET /api/themes`: theme names (sorted) and the server default (`ui.theme`); null default = follow the OS. */
export interface ThemesResponse {
  themes: string[];
  defaultTheme: string | null;
}

export interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  createdBy: string | null;
  settings: TaskSettings;
  integration: TaskIntegration;
  /** The current (or last) manager run; null before the first one. */
  managerRunId: string | null;
  /** Highest task message seq the manager consumed. */
  inboxAckedSeq: number;
  createdAt: number;
  updatedAt: number;
}

/** `GET /api/tasks/:id`: the task, its whole chat log and its runs (manager runs included), newest first. */
export interface TaskDetail {
  task: TaskRow;
  messages: TaskMessage[];
  runs: RunRow[];
}

/** `POST /api/tasks`: the task and the user's first message (the manager's first inbox item). */
export const CreateTaskBody = z.object({
  title: z.string().trim().min(1).max(TASK_TITLE_MAX),
  message: z.string().trim().min(1).max(TASK_MESSAGE_MAX),
  settings: TaskSettings,
});
export type CreateTaskBody = z.infer<typeof CreateTaskBody>;

/** `PATCH /api/tasks/:id`: rename, replace settings, or set the status (`done`/`archived` stop the manager). */
export const UpdateTaskBody = z.object({
  title: z.string().trim().min(1).max(TASK_TITLE_MAX).optional(),
  settings: TaskSettings.optional(),
  status: z.enum(["active", "done", "archived"]).optional(),
});
export type UpdateTaskBody = z.infer<typeof UpdateTaskBody>;

/** `POST /api/tasks/:id/messages`: a chat message, or the answer to an `ask_user` question (`answerTo` + `choice`). */
export const PostTaskMessageBody = z
  .object({
    text: z.string().max(TASK_MESSAGE_MAX).default(""),
    choice: z.string().min(1).optional(),
    answerTo: z.number().int().min(1).optional(),
  })
  .refine((b) => b.text.trim() !== "" || b.choice !== undefined, { message: "write a message or pick a choice", path: ["text"] })
  .refine((b) => (b.choice === undefined) === (b.answerTo === undefined), {
    message: "choice and answerTo go together",
    path: ["choice"],
  });
export type PostTaskMessageBody = z.infer<typeof PostTaskMessageBody>;
/** What a client sends: `text` may be left out (it defaults to `""`) for a choice answer. */
export type PostTaskMessageInput = z.input<typeof PostTaskMessageBody>;

/**
 * Items of the task stream `WS /api/tasks/:id/stream?afterSeq=N`; every frame is a JSON array of them.
 * The backlog (messages after `afterSeq`, the task, its runs) comes first, then live items:
 * - `message`: a new chat message (dedupe by `seq`);
 * - `task`: the task row changed (status, settings, manager run, integration);
 * - `run`: a run of the task changed (created or status), as its current row;
 * - `manager`: a live `acp.update` of the current manager run (its working transcript; not replayed).
 */
export const TaskStreamItem = z.discriminatedUnion("t", [
  z.object({ t: z.literal("message"), message: TaskMessage }),
  z.object({ t: z.literal("task"), task: z.custom<TaskRow>((v) => typeof v === "object" && v !== null) }),
  z.object({ t: z.literal("run"), run: z.custom<RunRow>((v) => typeof v === "object" && v !== null) }),
  z.object({ t: z.literal("manager"), event: RunEvent }),
]);
export type TaskStreamItem = z.infer<typeof TaskStreamItem>;

/** `POST /api/runners` `{name, labels?}` → the token is shown once. */
export interface CreateRunnerTokenResponse {
  runnerId: string;
  token: string;
}
