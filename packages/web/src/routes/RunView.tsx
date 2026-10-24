import { isAgentStep, TERMINAL_STATUSES, type WorkspaceInfo, templateVariables } from "@orch/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { ElicitationDialog } from "../components/ElicitationDialog";
import { InterventionDialog } from "../components/InterventionDialog";
import { PermissionDialog } from "../components/PermissionDialog";
import { KIND_ICON, KIND_LABEL } from "../components/StepPanel";
import { StepResult, Transcript } from "../components/Transcript";
import { applyRunEvents, initialRunViewState, type StepView } from "../runState";
import { Collapsible, CopyButton, formatDuration, formatTime, PrLink, StatusChip } from "../ui";
import { useRunEventStream } from "../ws";

const EMPTY_STEP: StepView = { status: "pending", items: [], toolCalls: {}, subagents: [] };

export function RunView() {
  const { id = "" } = useParams();
  return <RunViewInner key={id} runId={id} />;
}

function RunViewInner({ runId }: { runId: string }) {
  const [state, dispatch] = useReducer(applyRunEvents, initialRunViewState);
  const connected = useRunEventStream(runId, dispatch);
  const status = state.status;
  const terminal = status !== undefined && TERMINAL_STATUSES.includes(status);
  const detail = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(runId),
    refetchInterval: terminal ? false : 5000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(new Set());
  const cancel = useMutation({ mutationFn: () => api.cancelRun(runId) });
  const approve = useMutation({ mutationFn: () => api.approveRun(runId), onSuccess: () => detail.refetch() });

  // Pick up the final error/timestamps once the stream reports a terminal status.
  useEffect(() => {
    if (terminal) void detail.refetch();
  }, [terminal]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const run = detail.data?.run;
  const steps = run?.definition.steps ?? [];
  const selectedId = selected ?? state.currentStepId ?? steps[0]?.id ?? null;
  const step = (selectedId !== null && state.steps[selectedId]) || EMPTY_STEP;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [step, selectedId]);

  if (detail.error && !run) return <p className="error pad">{errorMessage(detail.error)}</p>;
  if (!run) return <p className="muted pad">Loading…</p>;

  const runStatus = status ?? run.status;
  const runTerminal = TERMINAL_STATUSES.includes(runStatus);
  const error = state.error ?? run.error;
  const stepRows = new Map(detail.data!.steps.map((s) => [s.stepId, s]));
  const findings = state.lastSeq > 0 ? state.findings : detail.data!.findings;
  const permission = state.permissions.find((p) => !p.resolved && !submitted.has(p.requestId));
  const elicitation = state.elicitations.find((e) => !e.resolved && !submitted.has(e.requestId));
  const intervention = state.interventions.find((i) => !i.resolved && !submitted.has(i.requestId));
  const [interventionOpen, setInterventionOpen] = useState(true);
  const markSubmitted = (requestId: string) => setSubmitted(new Set([...submitted, requestId]));
  const logs = state.logs.filter((l) => (l.stepId ?? null) === selectedId || l.stepId === undefined);
  const runLevel = state.steps[""];
  const selectedDef = steps.find((s) => s.id === selectedId);
  const selectedRow = selectedId !== null ? stepRows.get(selectedId) : undefined;
  // Live stream first; a reloaded (or already terminal) run falls back to the persisted workspace.
  const workspace = state.workspace ?? run.workspace ?? undefined;

  return (
    <div className="run-view">
      <div className="run-header">
        <div className="row gap wrap">
          <StatusChip status={runStatus} />
          <h2>
            <Link to={`/flows/${run.flowId}`}>{run.flowName}</Link>
          </h2>
          <span className="mono small muted">{run.id}</span>
          <span className={`dot ${connected ? "dot-on" : "dot-off"}`} title={connected ? "live" : "disconnected"} />
          <span className="grow" />
          {runStatus === "awaiting_approval" && !approve.isSuccess && (
            <button
              type="button"
              className="btn primary"
              disabled={approve.isPending}
              title="Run this untrusted pull request on a runner"
              onClick={() => approve.mutate()}
            >
              {approve.isPending ? "Approving…" : "Approve"}
            </button>
          )}
          {!runTerminal && (
            <button
              type="button"
              className="btn danger"
              disabled={cancel.isPending || cancel.isSuccess}
              onClick={() => cancel.mutate()}
            >
              {cancel.isSuccess ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
        <div className="run-meta small">
          <span>Created {formatTime(run.createdAt)}</span>
          {run.github && (
            <span>
              Pull request <PrLink github={run.github} />
            </span>
          )}
          <span>Duration {formatDuration(run.startedAt, run.finishedAt)}</span>
          {run.runnerId && (
            <span>
              Runner <span className="mono">{run.runnerId}</span>
            </span>
          )}
          {(workspace || runStatus === "running") && (
            <span className="row gap-tight">
              Workspace
              {workspace ? (
                <>
                  <span className="mono" title="Host path of the git worktree/checkout">
                    {workspace.path}
                  </span>
                  {workspace.branch && (
                    <span className="mono tag" title="Branch the run created">
                      {workspace.branch}
                    </span>
                  )}
                  {workspace.repo && (
                    <span className="mono tag" title="GitHub origin repo">
                      {workspace.repo}
                    </span>
                  )}
                  <CopyButton value={checkoutCommand(workspace)} title="Copy a git command that checks this branch out locally" />
                </>
              ) : (
                <span className="muted">preparing…</span>
              )}
            </span>
          )}
          {Object.keys(run.inputs).length > 0 && (
            <Collapsible summary="Inputs" className="inline-collapsible">
              <pre>{JSON.stringify(run.inputs, null, 2)}</pre>
            </Collapsible>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {intervention && !interventionOpen && (
          <button type="button" className="btn primary" onClick={() => setInterventionOpen(true)}>
            ⏸ Waiting for your review — step {intervention.stepId ?? "(unknown)"}
          </button>
        )}
        {cancel.error && <p className="error">{errorMessage(cancel.error)}</p>}
        {approve.error && <p className="error">{errorMessage(approve.error)}</p>}
        {findings.length > 0 && (
          <Collapsible summary={`Findings (${findings.length})`} defaultOpen>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Location</th>
                  <th>Message</th>
                  <th>Rule</th>
                  <th>Step</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f, i) => (
                  <tr key={i}>
                    <td>
                      <span className={`chip sev-${f.severity}`}>{f.severity}</span>
                    </td>
                    <td className="mono small">
                      {f.file}:{f.line}
                      {f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ""}
                    </td>
                    <td className="pre-wrap">{f.message}</td>
                    <td className="mono small">{f.ruleId}</td>
                    <td className="mono small">{f.stepId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Collapsible>
        )}
      </div>

      <div className="run-body">
        <nav className="step-list">
          {steps.map((s, idx) => {
            const row = stepRows.get(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className={`step-item ${s.id === selectedId ? "active" : ""}`}
                onClick={() => setSelected(s.id)}
              >
                <span className="step-index">{idx + 1}</span>
                <span className="step-item-text">
                  <span className="step-name">{s.name}</span>
                  <span className="step-item-sub">
                    <span className="step-id">{s.id}</span>
                    {row?.startedAt && <span className="muted">{formatDuration(row.startedAt, row.finishedAt)}</span>}
                  </span>
                </span>
                <StatusChip status={state.steps[s.id]?.status ?? row?.status ?? "pending"} />
              </button>
            );
          })}
        </nav>
        <div
          className="run-main"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {selectedDef && (
            <div className="step-header">
              <span className="kind-icon">{KIND_ICON[selectedDef.kind]}</span>
              <h3>{selectedDef.name}</h3>
              <span className="step-id">{selectedDef.id}</span>
              <span className="muted small">{KIND_LABEL[selectedDef.kind]}</span>
              <span className="grow" />
              {selectedRow?.startedAt && (
                <span className="muted small">{formatDuration(selectedRow.startedAt, selectedRow.finishedAt)}</span>
              )}
              <StatusChip status={state.steps[selectedDef.id]?.status ?? selectedRow?.status ?? "pending"} />
            </div>
          )}
          {step.items.length === 0 && step.subagents.length === 0 && step.output === undefined && !step.error && (
            <p className="muted">{step.status === "pending" ? "Step has not started." : "Waiting for output…"}</p>
          )}
          <Transcript step={step} />
          {selectedDef && (
            <StepResult step={step} stepId={selectedDef.id} markdown={isAgentStep(selectedDef) || selectedDef.kind === "slash"} />
          )}
          {runLevel && runLevel.items.length > 0 && (
            <Collapsible summary="Run-level updates" className="diagnostics">
              <Transcript step={runLevel} />
            </Collapsible>
          )}
          {logs.length > 0 && (
            <Collapsible summary={`Sandbox log (${logs.length})`} className="diagnostics small">
              <pre className="log">
                {logs.map((l) => (
                  <span key={l.seq} className={l.stream === "stderr" ? "log-err" : undefined}>
                    {l.text.endsWith("\n") ? l.text : `${l.text}\n`}
                  </span>
                ))}
              </pre>
            </Collapsible>
          )}
        </div>
      </div>

      {intervention && interventionOpen ? (
        <InterventionDialog
          key={intervention.requestId}
          runId={runId}
          request={intervention}
          variables={templateVariables(run.definition, Math.max(0, steps.findIndex((s) => s.id === intervention.stepId)))}
          onClose={() => setInterventionOpen(false)}
          onSubmitted={(id) => {
            markSubmitted(id);
            void detail.refetch();
          }}
        />
      ) : permission ? (
        <PermissionDialog key={permission.requestId} runId={runId} request={permission} onSubmitted={markSubmitted} />
      ) : (
        elicitation && (
          <ElicitationDialog
            key={elicitation.requestId}
            runId={runId}
            request={elicitation}
            onSubmitted={markSubmitted}
          />
        )
      )}
    </div>
  );
}

/** A single command that reproduces the run's workspace locally: for worktrees, a checkout of
 * the orchestrator branch; otherwise a plain `cd` into the (shared) workspace path. */
export function checkoutCommand(ws: WorkspaceInfo): string {
  if (ws.branch && ws.repo) {
    return `git fetch origin ${ws.branch} && git checkout ${ws.branch}`;
  }
  return `cd ${ws.path}`;
}
