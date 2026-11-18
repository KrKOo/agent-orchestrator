// REST response shapes shared by the server (`/api/*`) and the web UI.
// Timestamps are epoch milliseconds.
import { z } from "zod";
import { type Finding, RunStatus, type StepStatus } from "./events";
import type { FlowDefinition } from "./flow";
import type { CatalogEntry, ModelEntry, RunnerCapabilities } from "./wire";

export interface FlowRow {
  id: string;
  name: string;
  version: number;
  definition: FlowDefinition;
  createdAt: number;
  updatedAt: number;
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
}

/** `GET /api/runs` returns at most this many rows per page; a full page means there may be more. */
export const RUNS_PAGE_SIZE = 200;

/** Paging cursor for `GET /api/runs?before=`: the last row's sort key, `<createdAt>:<id>`. */
export function runsCursor(row: Pick<RunRow, "createdAt" | "id">): string {
  return `${row.createdAt}:${row.id}`;
}

/**
 * `GET /api/runs` query: `flowId`, `status` (comma list of run statuses), `before` (a `runsCursor`), and `q`
 * (case-insensitive substring of the run name or id). Empty values mean "no filter".
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
});
export type RunsQuery = z.infer<typeof RunsQuery>;

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

/** `POST /api/runners` `{name, labels?}` → the token is shown once. */
export interface CreateRunnerTokenResponse {
  runnerId: string;
  token: string;
}
