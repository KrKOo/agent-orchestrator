import {
  PR_DIFF_PATH,
  pullRequestInputOf,
  wrapUntrustedText,
  type FlowDefinition,
  type PullRequestInput,
  type RunStatus,
  type Trigger,
} from "@orch/protocol";
import { ulid } from "ulid";
import { schema } from "./db";
import type { AppDeps } from "./deps";
import type { PullRequestInfo } from "./github/api";

const { runs, runSteps } = schema;

export interface RunOrigin {
  triggerKind: "manual" | "github";
  createdBy?: string | null;
  /** App installation for token scoping, when known (webhook runs). */
  installationId?: number;
  /** Webhook dedupe: one run per flow/PR/head. Manual runs pass no key. */
  dedupeKey?: string;
  /** Initial run status; `awaiting_approval` for fork PRs under `require_approval`. */
  status?: RunStatus;
}

/**
 * Initial status of a PR run under the flow's `forkPolicy`, or null when the policy skips it. Only
 * PR-triggered flows have a policy; other flows run fork PRs as queued.
 */
export function initialPullRunStatus(trigger: Trigger, untrustedSource: boolean): RunStatus | null {
  if (!untrustedSource || trigger.kind !== "github_pull_request") return "queued";
  switch (trigger.forkPolicy) {
    case "skip":
      return null;
    case "require_approval":
      return "awaiting_approval";
    case "run":
      return "queued";
  }
}

/** Resolved value of a `github_pull_request` input; title and body are wrapped as untrusted text. */
export function pullRequestInput(pr: PullRequestInfo): PullRequestInput {
  return {
    url: pr.url,
    repo: pr.repo,
    number: pr.number,
    title: wrapUntrustedText(pr.title),
    body: wrapUntrustedText(pr.body),
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    diffPath: PR_DIFF_PATH,
  };
}

/**
 * Inserts a run of `flow` with resolved `inputs` and one pending row per step. A flow with a pull request
 * input yields an untrusted run whose `runs.github` pins that PR (checkout, check run, review, per-repo cap).
 * Returns the run id, or null when the insert lost a dedupe race.
 */
export function insertRun(
  deps: Pick<AppDeps, "db">,
  flow: { id: string; version: number; definition: FlowDefinition },
  inputs: Record<string, unknown>,
  origin: RunOrigin,
): string | null {
  const prDef = pullRequestInputOf(flow.definition);
  const pr = prDef ? (inputs[prDef.key] as PullRequestInput) : undefined;
  const id = ulid();
  const inserted = deps.db.transaction((tx) => {
    const rows = tx
      .insert(runs)
      .values({
        id,
        flowId: flow.id,
        flowVersion: flow.version,
        definition: flow.definition,
        inputs,
        status: origin.status ?? "queued",
        trust: pr ? "untrusted" : "owner",
        triggerKind: origin.triggerKind,
        ...(origin.dedupeKey !== undefined ? { dedupeKey: origin.dedupeKey } : {}),
        createdBy: origin.createdBy ?? null,
        ...(pr
          ? {
              github: {
                ...(origin.installationId !== undefined ? { installationId: origin.installationId } : {}),
                repo: pr.repo,
                number: pr.number,
                headSha: pr.headSha,
                baseSha: pr.baseSha,
              },
            }
          : {}),
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .returning({ id: runs.id })
      .all();
    if (rows.length === 0) return false;
    tx.insert(runSteps)
      .values(flow.definition.steps.map((s, idx) => ({ runId: id, stepId: s.id, idx, status: "pending" as const })))
      .run();
    return true;
  });
  return inserted ? id : null;
}
