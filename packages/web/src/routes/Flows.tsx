// Flows list: cards-in-a-table grid, step pills, run dialog, and delete behind a confirm dialog.
import type { FlowOrigin, FlowRow, Step } from "@orch/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Play, Plus, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { RunDialog } from "../components/RunDialog";
import { KIND_LABEL } from "../components/StepPanel";
import { KindIcon } from "../components/icons";
import { EmptyState, PageHeader, RelativeTime, Skeleton, Tabs, useConfirm, usePageTitle } from "../ui";
import { useToast } from "../components/Toast";

/** Step pills beyond this count collapse into a `+N` overflow pill. */
const MAX_STEP_PILLS = 8;

export function Flows() {
  usePageTitle("Flows");
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const [running, setRunning] = useState<FlowRow | null>(null);
  // User flows by default: manager-created ones belong to their task's chat, where they start runs.
  const [origin, setOrigin] = useState<FlowOrigin | "all">("user");
  const flows = useQuery({ queryKey: ["flows"], queryFn: api.listFlows });
  const promote = useMutation({
    mutationFn: api.promoteFlow,
    onSuccess: (flow) => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      toast(`“${flow.name}” is now one of your flows`, { kind: "success" });
    },
    onError: (err) => toast(`Promote failed: ${errorMessage(err)}`, { kind: "error" }),
  });
  const del = useMutation({
    mutationFn: api.deleteFlow,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      toast("Flow deleted", { kind: "success" });
    },
    onError: (err) => toast(`Delete failed: ${errorMessage(err)}`, { kind: "error" }),
  });

  const remove = async (flow: FlowRow) => {
    const ok = await confirm({
      title: `Delete “${flow.name}”?`,
      body: `Flow “${flow.name}” stops receiving pull request triggers. Existing runs keep going and keep their history.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) del.mutate(flow.id);
  };

  // Builtin flows always show; the filter decides the other two origins.
  const shown = (flows.data ?? []).filter((f) =>
    f.origin === "builtin" ? origin !== "manager" : origin === "all" || f.origin === origin,
  );

  return (
    <div className="page">
      <PageHeader
        title="Flows"
        actions={
          <Link className="btn primary" to="/flows/new">
            <Plus size={15} aria-hidden />
            New flow
          </Link>
        }
      />
      {confirmDialog}
      {flows.isPending ? (
        <Skeleton rows={5} />
      ) : flows.error && !flows.data ? (
        <p className="error">{errorMessage(flows.error)}</p>
      ) : !flows.data || flows.data.length === 0 ? (
        <EmptyState
          icon={<Workflow size={32} />}
          title="No flows yet"
          action={
            <Link className="btn primary" to="/flows/new">
              Create your first flow
            </Link>
          }
        >
          A flow is a pipeline of steps that runs in a sandbox.
        </EmptyState>
      ) : (
        <>
          <div className="runs-toolbar">
            <Tabs
              label="Filter flows by origin"
              tabs={[
                { id: "user", label: "User" },
                { id: "manager", label: "Manager-created" },
                { id: "all", label: "All" },
              ]}
              value={origin}
              onChange={setOrigin}
            />
          </div>
          {shown.length === 0 ? (
            origin === "manager" ? (
              <EmptyState title="No manager-created flows">
                Flows a task's manager saved appear here; promote one to keep it after the task is gone.
              </EmptyState>
            ) : (
              <EmptyState title="No flows match the current filter">
                <button type="button" className="btn" onClick={() => setOrigin("all")}>
                  Show all flows
                </button>
              </EmptyState>
            )
          ) : (
            <div role="table" aria-label="Flows" className="list">
              <div role="row" className="list-grid flows-grid list-head">
                <div role="columnheader" className="cell-name">
                  Name
                </div>
                <div role="columnheader" className="cell-steps">
                  Steps
                </div>
                <div role="columnheader" className="cell-meta">
                  Trigger / workspace / version / updated
                </div>
                <div role="columnheader" className="cell-actions" />
              </div>
              {shown.map((f) => (
                <div role="row" key={f.id} className="list-grid flows-grid list-row">
                  <div role="cell" className="cell-name">
                    <Link to={`/flows/${f.id}`} className="list-row-link run-name">
                      {f.name}
                    </Link>
                  </div>
                  <div role="cell" className="cell-steps">
                    <StepPills steps={f.definition.steps} />
                  </div>
                  <div role="cell" className="cell-meta">
                    <span className="cell-trigger small">
                      {f.definition.trigger.kind === "github_pull_request"
                        ? `PRs · ${f.definition.trigger.repos.join(", ")}`
                        : "manual"}
                    </span>
                    <span className="cell-workspace mono small">
                      {f.definition.workspace.kind === "local_path" ? f.definition.workspace.path : "PR checkout"}
                    </span>
                    <span className="cell-version">v{f.version}</span>
                    <span className="cell-updated">
                      <RelativeTime ts={f.updatedAt} />
                    </span>
                  </div>
                  <div role="cell" className="cell-actions">
                    {/* Buttons sit above the stretched row link so they stay independently clickable. */}
                    <button type="button" className="btn small" title={`Run ${f.name}`} onClick={() => setRunning(f)}>
                      <Play size={13} aria-hidden />
                      Run
                    </button>
                    <Link className="btn small" to={`/runs?flowId=${f.id}`}>
                      Runs
                    </Link>
                    {f.origin === "manager" && f.taskId && (
                      <>
                        <button
                          type="button"
                          className="btn small"
                          disabled={promote.isPending}
                          title="Turn this manager-created flow into a user flow so it outlives its task"
                          onClick={() => promote.mutate(f.id)}
                        >
                          <ArrowUpRight size={13} aria-hidden />
                          Promote
                        </button>
                        <Link className="btn small" to={`/tasks/${f.taskId}`}>
                          Task
                        </Link>
                      </>
                    )}
                    <button
                      type="button"
                      className="btn small danger"
                      title={`Delete ${f.name}`}
                      disabled={del.isPending}
                      onClick={() => void remove(f)}
                    >
                      <Trash2 size={13} aria-hidden />
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {running && <RunDialog flow={running} onClose={() => setRunning(null)} />}
    </div>
  );
}

/** One pill per step; loops show a repeat icon titled with their jump target. */
function StepPills({ steps }: { steps: Step[] }) {
  const shown = steps.slice(0, MAX_STEP_PILLS);
  const extra = steps.length - shown.length;
  return (
    <div className="step-pills">
      {shown.map((step) =>
        step.kind === "loop" ? (
          <span key={step.id} className="step-pill" title={`Loop back to ${step.to}`}>
            <KindIcon kind="loop" size={13} label={`Loop back to ${step.to}`} />
          </span>
        ) : (
          <span key={step.id} className="step-pill" title={`${step.name} (${KIND_LABEL[step.kind]})`}>
            <KindIcon kind={step.kind} size={13} label={step.name} />
          </span>
        ),
      )}
      {extra > 0 && (
        <span className="step-pill step-pill-more" title={`${extra} more step${extra === 1 ? "" : "s"}`}>
          +{extra}
        </span>
      )}
    </div>
  );
}
