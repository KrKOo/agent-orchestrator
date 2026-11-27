import { validateFlow, type FlowDefinition, type HarnessModels } from "@orch/protocol";

export const RESOLVE_CONFLICTS_FLOW_ID = "builtin:resolve-conflicts";

/**
 * Owner run on the task repo clone: no untrusted preamble. `{{inputs.onto}}` is the host-fetched
 * `fetchedBranchRef(base)` ref, so the rebase needs no network; the push happens in the following
 * `git_push` step, never by the agent.
 */
const RESOLVE_PROMPT = `You are resolving merge conflicts on the pull request {{inputs.pr_url}}. You are in a git worktree of the PR head branch {{inputs.head}}; the pull request targets {{inputs.base}}.

Rebase the worktree branch onto {{inputs.onto}}. That ref was fetched by the orchestrator before this run: git can read it, but never fetch, pull or push over the network.

Resolve every conflict so the result keeps the intent of both sides — the changes coming from {{inputs.base}} and the changes this branch made. Do not simply drop one side.

After the rebase completes:
- Run the project's tests and linters if they are available in this workspace, and fix failures caused by the rebase or your conflict resolution.
- Make sure the result is committed: a finished rebase leaves its commits in place, so leave them exactly as the rebase produced them. Never amend, squash or create extra commits, and never push — a later step pushes the branch.

Then submit: summary — what you rebased onto, how you resolved each conflict, and what you changed; checks — the outcome of the tests and linters you ran, or that none were available.`;

/**
 * Definition for a run on the task repo clone at `localPath` (workspace local_path, isolation worktree).
 * Not stored in the flows table (its workspace path is per task); runs use `RESOLVE_CONFLICTS_FLOW_ID`.
 * The server starts it with overrides `{ baseBranch: head, fetchBranches: [base], pushBranch: head,
 * forcePush: true }`, so the worktree starts from the PR head and the push step force-updates it.
 */
export function resolveConflictsDefinition(localPath: string, models: HarnessModels): FlowDefinition {
  const v = validateFlow({
    name: "Resolve conflicts",
    inputs: [
      { key: "pr_url", label: "Pull request URL", type: "text" },
      { key: "head", label: "PR head branch", type: "text" },
      { key: "base", label: "PR base branch", type: "text" },
      { key: "onto", label: "Ref to rebase onto", type: "text" },
    ],
    workspace: { kind: "local_path", path: localPath, isolation: "worktree", access: "rw" },
    harness: { id: "omp", ...models },
    steps: [
      {
        id: "resolve",
        name: "Resolve conflicts",
        kind: "prompt",
        prompt: RESOLVE_PROMPT,
        timeoutSec: 3600,
        structured: {
          fields: [
            { name: "summary", description: "What was rebased onto what, how each conflict was resolved, what was changed" },
            { name: "checks", description: "Outcome of the tests and linters that ran, or that none were available" },
          ],
        },
      },
      { id: "push", name: "Push rebased branch", kind: "git_push" },
    ],
  });
  // A broken built-in definition is a programming error, not user input.
  if (!v.ok) throw new Error(`builtin resolve-conflicts flow is invalid: ${v.errors.join("; ")}`);
  return v.flow;
}
