import { z } from "zod";
import { RunEvent, RunStatus } from "./events";
import { FlowDefinition, InterventionAction } from "./flow";

export const WIRE_PROTOCOL = 1;

export const CatalogEntry = z.object({ name: z.string(), description: z.string() });
export type CatalogEntry = z.infer<typeof CatalogEntry>;

/** One routable model advertised by a runner's gateway (`provider/model` id plus display name). */
export const ModelEntry = z.object({ id: z.string(), name: z.string() });
export type ModelEntry = z.infer<typeof ModelEntry>;

export const RunnerCapabilities = z.object({
  labels: z.array(z.string()),
  maxConcurrentJobs: z.number().int().min(1),
  allowedRoots: z.array(z.string()),
  harnesses: z.array(z.object({ id: z.string(), version: z.string() })),
  /** Optional on the wire (defaults empty) so pre-model runners still parse; runners advertise it in hello. */
  models: z.array(ModelEntry).default([]),
  sandboxProviders: z.array(z.literal("docker")),
  acceptUntrusted: z.boolean(),
  skills: z.array(CatalogEntry),
  commands: z.array(CatalogEntry),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;

export const AssignedRun = z.object({
  runId: z.string(),
  trust: z.enum(["owner", "untrusted"]),
  definition: FlowDefinition,
  /** Resolved inputs: `github_issue` inputs are `GitHubIssueInput` objects. */
  inputs: z.record(z.string(), z.unknown()),
  /** Present for `github_pull_request` runs; the runner checks out `headSha` on the host. */
  github: z
    .object({ repo: z.string(), number: z.number().int(), headSha: z.string(), baseSha: z.string() })
    .optional(),
});
export type AssignedRun = z.infer<typeof AssignedRun>;

// ---- RPC methods -------------------------------------------------------------

export const GitHubTokenParams = z.object({
  runId: z.string(),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  access: z.enum(["read", "write"]),
});
export type GitHubTokenParams = z.infer<typeof GitHubTokenParams>;
export interface GitHubTokenResult {
  token: string;
}

export const CreatePullRequestParams = z.object({
  runId: z.string(),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  head: z.string().min(1),
  base: z.string().min(1).nullable(),
  title: z.string().min(1),
  body: z.string(),
  draft: z.boolean(),
});
export type CreatePullRequestParams = z.infer<typeof CreatePullRequestParams>;
export interface CreatePullRequestResult {
  url: string;
  number: number;
}

export const FsListParams = z.object({ path: z.string() });
export type FsListParams = z.infer<typeof FsListParams>;
export interface FsListResult {
  path: string;
  entries: { name: string; path: string; isDir: true; isGitRepo: boolean }[];
}

const RpcResult = z.union([
  z.object({ t: z.literal("rpc.result"), rpcId: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ t: z.literal("rpc.result"), rpcId: z.string(), ok: z.literal(false), error: z.string() }),
]);
export type RpcResult = z.infer<typeof RpcResult>;

// ---- Runner → server -----------------------------------------------------------

export const RunnerRpcCall = z.discriminatedUnion("method", [
  z.object({ t: z.literal("rpc.call"), rpcId: z.string(), method: z.literal("github.token"), params: GitHubTokenParams }),
  z.object({
    t: z.literal("rpc.call"),
    rpcId: z.string(),
    method: z.literal("github.createPullRequest"),
    params: CreatePullRequestParams,
  }),
]);
export type RunnerRpcCall = z.infer<typeof RunnerRpcCall>;

export const RunnerMessage = z.union([
  z.object({
    t: z.literal("hello"),
    protocol: z.literal(WIRE_PROTOCOL),
    runnerId: z.string(),
    version: z.string(),
    capabilities: RunnerCapabilities,
  }),
  z.object({ t: z.literal("job.accepted"), runId: z.string() }),
  z.object({ t: z.literal("job.rejected"), runId: z.string(), reason: z.string() }),
  z.object({ t: z.literal("job.events"), runId: z.string(), events: z.array(RunEvent) }),
  z.object({ t: z.literal("job.finished"), runId: z.string(), status: RunStatus, error: z.string().optional() }),
  RpcResult,
  RunnerRpcCall,
  z.object({ t: z.literal("ping") }),
]);
export type RunnerMessage = z.infer<typeof RunnerMessage>;

// ---- Server → runner -----------------------------------------------------------

export const ServerRpcCall = z.object({
  t: z.literal("rpc.call"),
  rpcId: z.string(),
  method: z.literal("fs.list"),
  params: FsListParams,
});
export type ServerRpcCall = z.infer<typeof ServerRpcCall>;

export const ElicitationAction = z.enum(["accept", "decline", "cancel"]);
export type ElicitationAction = z.infer<typeof ElicitationAction>;

export const ServerMessage = z.union([
  z.object({ t: z.literal("welcome"), lastAckedSeq: z.record(z.string(), z.number().int()) }),
  z.object({ t: z.literal("job.assign"), run: AssignedRun }),
  z.object({ t: z.literal("job.cancel"), runId: z.string() }),
  z.object({ t: z.literal("job.ack"), runId: z.string(), seq: z.number().int() }),
  ServerRpcCall,
  RpcResult,
  z.object({
    t: z.literal("permission.respond"),
    runId: z.string(),
    requestId: z.string(),
    optionId: z.string().nullable(),
  }),
  z.object({
    t: z.literal("elicitation.respond"),
    runId: z.string(),
    requestId: z.string(),
    action: ElicitationAction,
    content: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    t: z.literal("intervention.respond"),
    runId: z.string(),
    requestId: z.string(),
    action: InterventionAction,
    /** `message`/`continue`: id of one of the request's `sessions`. */
    session: z.string().optional(),
    /** `message`: text sent verbatim to the session (slash commands included). */
    text: z.string().optional(),
  }),
  z.object({ t: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
