// REST response shapes shared by the server (`/api/*`) and the web UI.
// Timestamps are epoch milliseconds.
import type { Finding, RunStatus, StepStatus } from "./events";
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
  github: RunGitHubInfo | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Host workspace (worktree or direct path) the runner prepared, set once the run starts. */
  workspace: WorkspaceInfo | null;
}

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

/** `POST /api/runners` `{name, labels?}` → the token is shown once. */
export interface CreateRunnerTokenResponse {
  runnerId: string;
  token: string;
}
