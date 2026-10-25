import { PR_DIFF_PATH, wrapUntrustedText, type PullRequestInput, type RunStatus } from "@orch/protocol";
import { ulid } from "ulid";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import type { FlowDefinition } from "@orch/protocol";
import type { PullRunInput } from "./api";

const { runs, runSteps } = schema;

export interface PrRunOrigin {
  /** App installation for token scoping, when known (webhook runs). */
  installationId?: number;
  /** Webhook dedupe: one run per flow/PR/head. Manual runs pass no key. */
  dedupeKey?: string;
  /** Initial run status; `awaiting_approval` for fork PRs under `require_approval`. */
  status?: RunStatus;
  trust: "owner" | "untrusted";
  triggerKind: "manual" | "github";
  createdBy?: string | null;
}

/**
 * Inserts one run for a PR flow and a resolved pull request: `inputs.pr`, `runs.github`, and one
 * pending row per step. Returns the run id, or null when the insert lost a dedupe race.
 */
export function startPullRequestRun(
  deps: Pick<AppDeps, "db">,
  flow: { id: string; version: number; definition: FlowDefinition },
  pr: PullRunInput,
  origin: PrRunOrigin,
): string | null {
  const { db } = deps;
  const prInput: PullRequestInput = {
    repo: pr.repo,
    number: pr.number,
    title: wrapUntrustedText(pr.title),
    body: wrapUntrustedText(pr.body),
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    diffPath: PR_DIFF_PATH,
  };
  const id = ulid();
  const inserted = db.transaction((tx) => {
    const rows = tx
      .insert(runs)
      .values({
        id,
        flowId: flow.id,
        flowVersion: flow.version,
        definition: flow.definition,
        inputs: { pr: prInput },
        status: origin.status ?? "queued",
        trust: origin.trust,
        triggerKind: origin.triggerKind,
        ...(origin.dedupeKey !== undefined ? { dedupeKey: origin.dedupeKey } : {}),
        createdBy: origin.createdBy ?? null,
        github: {
          ...(origin.installationId !== undefined ? { installationId: origin.installationId } : {}),
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headSha,
          baseSha: pr.baseSha,
        },
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
