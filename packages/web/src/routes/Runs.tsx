import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { api, errorMessage } from "../api";
import { formatDuration, formatTime, PrLink, StatusChip } from "../ui";

export function Runs() {
  const [params, setParams] = useSearchParams();
  const flowId = params.get("flowId") ?? undefined;
  const runs = useQuery({
    queryKey: ["runs", flowId ?? null],
    queryFn: () => api.listRuns(flowId),
    refetchInterval: 3000,
  });

  return (
    <div className="page">
      <div className="page-header">
        <h2>Runs</h2>
        {flowId && (
          <span className="muted">
            filtered by flow <span className="mono">{flowId}</span>{" "}
            <button type="button" className="btn small" onClick={() => setParams({})}>
              Clear
            </button>
          </span>
        )}
      </div>
      {runs.error && <p className="error">{errorMessage(runs.error)}</p>}
      {runs.data && runs.data.length === 0 && <p className="muted">No runs yet.</p>}
      {runs.data && runs.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Flow</th>
              <th>Run</th>
              <th>Trigger</th>
              <th>Created</th>
              <th>Duration</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((r) => (
              <tr key={r.id}>
                <td>
                  <StatusChip status={r.status} />
                </td>
                <td>
                  <Link to={`/flows/${r.flowId}`}>{r.flowName}</Link> <span className="muted">v{r.flowVersion}</span>
                </td>
                <td>
                  <Link className="mono" to={`/runs/${r.id}`}>
                    {r.id}
                  </Link>
                </td>
                <td>
                  <span className="tag">{r.triggerKind}</span>
                  {r.github && <PrLink github={r.github} />}
                </td>
                <td>{formatTime(r.createdAt)}</td>
                <td>{formatDuration(r.startedAt, r.finishedAt)}</td>
                <td className="error small">{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
