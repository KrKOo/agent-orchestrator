// Runs list: status tabs + search kept in the URL query, infinite pages, and every row links to its run.
import { RUNS_PAGE_SIZE, runsCursor } from "@orch/protocol";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, errorMessage } from "../api";
import { RUNS_TABS, filterStatuses, parseRunsFilter, runsFilterSearch, type RunsFilter, type RunsTab } from "../runsFilter";
import {
  EmptyState,
  PageHeader,
  RelativeTime,
  Skeleton,
  StatusChip,
  Tabs,
  formatDuration,
  githubRefsOf,
  IssueLink,
  PrLink,
  usePageTitle,
} from "../ui";

/** How long typing waits before the search is committed to the URL (keeps back/forward usable). */
const SEARCH_DEBOUNCE_MS = 300;

export function Runs() {
  usePageTitle("Runs");
  const [params, setParams] = useSearchParams();
  const filter = parseRunsFilter(params);
  const writeFilter = useCallback((next: RunsFilter) => setParams(runsFilterSearch(next), { replace: true }), [setParams]);

  // The search box is local so typing never waits on the network; commits land debounced in the query string.
  const [search, setSearch] = useState(filter.q);
  const lastWritten = useRef<string | null>(null); // the q we just put in the URL, so it doesn't echo into the box
  // The pending commit merges into the filter as it is when the timer fires: a tab click during the
  // debounce window must survive it.
  const latestFilter = useRef(filter);
  latestFilter.current = filter;
  // Compared trimmed: the URL keeps `q` trimmed, while the box must keep a trailing space being typed.
  useEffect(() => {
    const q = search.trim();
    if (q === filter.q.trim()) return;
    const timer = setTimeout(() => {
      lastWritten.current = q;
      writeFilter({ ...latestFilter.current, q });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `filter` is excluded on purpose: the effect tracks typing, not URL rewrites (its effect is below).
  }, [search, writeFilter]);
  // External URL changes (back/forward, the attention badge) update the box, unless we just wrote this q
  // or the box already holds it (modulo surrounding spaces).
  useEffect(() => {
    if (lastWritten.current === filter.q) lastWritten.current = null;
    else if (search.trim() !== filter.q.trim()) setSearch(filter.q);
  }, [filter.q]);

  const statuses = filterStatuses(filter);
  const filtered = filter.tab !== "all" || filter.q.trim() !== "" || !!filter.flowId;
  const flows = useQuery({ queryKey: ["flows"], queryFn: api.listFlows, enabled: !!filter.flowId });
  const runs = useInfiniteQuery({
    queryKey: ["runs", "list", filter.flowId ?? null, statuses, filter.q],
    queryFn: ({ pageParam }) =>
      api.listRuns({
        flowId: filter.flowId,
        status: statuses.length ? statuses : undefined,
        q: filter.q.trim() || undefined,
        before: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    // A full page means there may be more; the cursor is the last row's sort key.
    getNextPageParam: (last) => (last.length >= RUNS_PAGE_SIZE ? runsCursor(last[last.length - 1]) : undefined),
    // A refetch re-requests every loaded page, so poll only the first; after "Load more" the list holds
    // still while the user reads further back (a filter change or reload starts polling again).
    refetchInterval: (q) => ((q.state.data?.pages.length ?? 1) > 1 ? false : 3000),
  });
  const rows = runs.data ? runs.data.pages.flat() : [];
  // Name the flow filter's flow: from the flows query when loaded, else from any fetched run row.
  const flowName = filter.flowId
    ? (flows.data?.find((f) => f.id === filter.flowId)?.name ??
      rows.find((r) => r.flowId === filter.flowId)?.flowName ??
      filter.flowId)
    : null;

  return (
    <div className="page">
      <PageHeader
        title="Runs"
        subtitle={
          filter.flowId ? (
            <>
              Flow: <strong>{flowName}</strong>{" "}
              <button type="button" className="btn small" onClick={() => writeFilter({ ...filter, flowId: undefined })}>
                Clear
              </button>
            </>
          ) : undefined
        }
      />
      <div className="runs-toolbar">
        {/* A hand-written `status` list no tab matches keeps filtering: no tab is selected, the note below explains. */}
        <Tabs
          label="Filter runs by status"
          tabs={RUNS_TABS.map(({ id, label }) => ({ id, label }))}
          value={filter.tab === "custom" ? "" : filter.tab}
          onChange={(id) => writeFilter({ ...filter, tab: id as RunsTab })}
        />
        <input
          type="search"
          className="runs-search"
          placeholder="Search name or id"
          aria-label="Search runs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {filter.tab === "custom" && (
        <p className="runs-note">
          Custom status filter: {filter.statuses?.length ? filter.statuses.map((s) => s.replaceAll("_", " ")).join(", ") : "none"}{" "}
          <button
            type="button"
            className="btn small"
            onClick={() => writeFilter({ ...filter, tab: "all", statuses: undefined })}
          >
            Clear
          </button>
        </p>
      )}
      {runs.isPending ? (
        <Skeleton rows={6} />
      ) : runs.error && !runs.data ? (
        <p className="error">{errorMessage(runs.error)}</p>
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No runs match the current filters"
            action={
              <button type="button" className="btn" onClick={() => writeFilter({ tab: "all", q: "", flowId: undefined })}>
                Clear filters
              </button>
            }
          >
            Try a different status, search, or flow.
          </EmptyState>
        ) : (
          <EmptyState
            icon={<Play size={32} />}
            title="No runs yet"
            action={
              <Link className="btn primary" to="/flows">
                Go to flows
              </Link>
            }
          >
            Start a run from one of your flows.
          </EmptyState>
        )
      ) : (
        <>
          {runs.error && <p className="error">{errorMessage(runs.error)}</p>}
          <div role="table" aria-label="Runs" className="list">
            <div role="row" className="list-grid runs-grid list-head">
              <div role="columnheader" className="cell-status">
                Status
              </div>
              <div role="columnheader" className="cell-name">
                Name
              </div>
              <div role="columnheader" className="cell-trigger">
                Trigger
              </div>
              <div role="columnheader" className="cell-created">
                Created
              </div>
              <div role="columnheader" className="cell-duration">
                Duration
              </div>
            </div>
            {rows.map((r) => {
              const refs = r.name ? [] : githubRefsOf(r);
              return (
                <div role="row" key={r.id} className="list-grid runs-grid list-row">
                  <div role="cell" className="cell-status">
                    <StatusChip status={r.status} />
                  </div>
                  <div role="cell" className="cell-name">
                    {/* The row's link: its ::after stretches over the whole row (see list pages CSS). */}
                    <Link to={`/runs/${r.id}`} className="list-row-link">
                      {r.name ? (
                        <span className="run-name">{r.name}</span>
                      ) : (
                        // Without a name the run is identified by its GitHub refs (linked below) or a short id.
                        <span className="mono muted">{r.id.slice(-8)}</span>
                      )}
                    </Link>
                    {refs.length > 0 && (
                      <div className="cell-refs">
                        {refs.map((ref) => (
                          <IssueLink key={ref.url} githubRef={ref} />
                        ))}
                      </div>
                    )}
                    <div className="cell-sub small">
                      <Link to={`/flows/${r.flowId}`} className="cell-flow">
                        {r.flowName}
                      </Link>{" "}
                      <span className="muted">v{r.flowVersion}</span>
                    </div>
                    {r.error && (
                      <div className="cell-error small" title={r.error}>
                        {r.error}
                      </div>
                    )}
                  </div>
                  <div role="cell" className="cell-trigger">
                    <span className="tag">{r.triggerKind}</span>
                    {r.github && <PrLink github={r.github} />}
                  </div>
                  <div role="cell" className="cell-created">
                    <RelativeTime ts={r.createdAt} />
                  </div>
                  <div role="cell" className="cell-duration">
                    {formatDuration(r.startedAt, r.finishedAt)}
                  </div>
                </div>
              );
            })}
          </div>
          {runs.hasNextPage && (
            <div className="list-more">
              <button
                type="button"
                className="btn"
                disabled={runs.isFetchingNextPage}
                onClick={() => void runs.fetchNextPage()}
              >
                {runs.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
