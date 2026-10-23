import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { formatTime } from "../ui";

export function Flows() {
  const qc = useQueryClient();
  const flows = useQuery({ queryKey: ["flows"], queryFn: api.listFlows });
  const del = useMutation({
    mutationFn: api.deleteFlow,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flows"] }),
  });

  return (
    <div className="page">
      <div className="page-header">
        <h2>Flows</h2>
        <Link className="btn primary" to="/flows/new">
          New flow
        </Link>
      </div>
      {flows.error && <p className="error">{errorMessage(flows.error)}</p>}
      {del.error && <p className="error">{errorMessage(del.error)}</p>}
      {flows.data && flows.data.length === 0 && <p className="muted">No flows yet.</p>}
      {flows.data && flows.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Steps</th>
              <th>Trigger</th>
              <th>Workspace</th>
              <th>Version</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {flows.data.map((f) => (
              <tr key={f.id}>
                <td>
                  <Link to={`/flows/${f.id}`}>{f.name}</Link>
                </td>
                <td>{f.definition.steps.map((s) => s.kind).join(" → ")}</td>
                <td className="small">
                  {f.definition.trigger.kind === "github_pull_request"
                    ? `PRs · ${f.definition.trigger.repos.join(", ")}`
                    : "manual"}
                </td>
                <td className="mono small">
                  {f.definition.workspace.kind === "local_path" ? f.definition.workspace.path : "PR checkout"}
                </td>
                <td>v{f.version}</td>
                <td>{formatTime(f.updatedAt)}</td>
                <td className="actions">
                  <Link className="btn small" to={`/runs?flowId=${f.id}`}>
                    Runs
                  </Link>
                  <button
                    type="button"
                    className="btn small danger"
                    disabled={del.isPending}
                    onClick={() => confirm(`Delete flow "${f.name}"?`) && del.mutate(f.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
