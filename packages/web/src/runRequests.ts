// Which unanswered request the run view banners and docks. Pure so the dock/banner wiring stays
// replay-safe like the rest of the run view state and can be tested without a DOM.
import type { ElicitationView, InterventionView, PermissionView, RunViewState } from "./runState";

export type PendingRequest =
  | { kind: "permission"; request: PermissionView }
  | { kind: "elicitation"; request: ElicitationView }
  | { kind: "intervention"; request: InterventionView };

/**
 * First unanswered request in dock priority order (permission > elicitation > intervention), matching
 * the run pane's single dock slot: the higher-priority panel occupies it until it is answered.
 * Requests answered from this browser (`submitted`) or already resolved elsewhere are skipped.
 */
export function pendingRequest(state: RunViewState, submitted: ReadonlySet<string>): PendingRequest | undefined {
  const unanswered = <T extends { requestId: string; resolved: boolean }>(list: T[]) =>
    list.find((r) => !r.resolved && !submitted.has(r.requestId));
  const permission = unanswered(state.permissions);
  if (permission) return { kind: "permission", request: permission };
  const elicitation = unanswered(state.elicitations);
  if (elicitation) return { kind: "elicitation", request: elicitation };
  const intervention = unanswered(state.interventions);
  return intervention ? { kind: "intervention", request: intervention } : undefined;
}
