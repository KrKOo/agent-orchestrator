// Runs list filter <-> URL query (`/runs?status=a,b&q=…&flowId=…`). Pure, so it is unit-tested.
import { RUN_STATUSES, type RunStatus, TERMINAL_STATUSES } from "@orch/protocol";

/** Runs waiting for a human: the sidebar badge count and the "Needs you" tab. */
export const ATTENTION_STATUSES: readonly RunStatus[] = ["awaiting_input", "awaiting_approval"];

export type RunsTab = "all" | "active" | "attention" | "failed" | "succeeded";

export const RUNS_TABS: readonly { id: RunsTab; label: string; statuses: readonly RunStatus[] }[] = [
  { id: "all", label: "All", statuses: [] },
  { id: "active", label: "Active", statuses: RUN_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s)) },
  { id: "attention", label: "Needs you", statuses: ATTENTION_STATUSES },
  { id: "failed", label: "Failed", statuses: ["failed"] },
  { id: "succeeded", label: "Succeeded", statuses: ["succeeded"] },
];

export interface RunsFilter {
  /** A tab, or `custom` for a hand-written `status` list no tab matches (kept as-is). */
  tab: RunsTab | "custom";
  /** Only meaningful for `custom`; tabs carry their own statuses. */
  statuses?: readonly RunStatus[];
  q: string;
  flowId?: string;
}

const KNOWN = new Set<string>(RUN_STATUSES);

/** Unknown statuses are dropped (the server would 400 on them); an empty list means "all". */
export function parseRunsFilter(params: URLSearchParams): RunsFilter {
  const raw = (params.get("status") ?? "").split(",").filter((s) => KNOWN.has(s)) as RunStatus[];
  const statuses = [...new Set(raw)];
  const tab = RUNS_TABS.find((t) => t.statuses.length === statuses.length && t.statuses.every((s) => statuses.includes(s)));
  const flowId = params.get("flowId") || undefined;
  return {
    tab: tab?.id ?? "custom",
    ...(tab ? {} : { statuses }),
    q: params.get("q") ?? "",
    ...(flowId ? { flowId } : {}),
  };
}

/** Statuses to send to `GET /api/runs` for this filter (empty = all). */
export function filterStatuses(filter: RunsFilter): readonly RunStatus[] {
  if (filter.tab === "custom") return filter.statuses ?? [];
  return RUNS_TABS.find((t) => t.id === filter.tab)!.statuses;
}

/** `?status=…&q=…&flowId=…` (or `""`); commas stay readable in the status list. */
export function runsFilterSearch(filter: RunsFilter): string {
  const parts: string[] = [];
  const statuses = filterStatuses(filter);
  if (statuses.length) parts.push(`status=${statuses.join(",")}`);
  const q = filter.q.trim();
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (filter.flowId) parts.push(`flowId=${encodeURIComponent(filter.flowId)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}
