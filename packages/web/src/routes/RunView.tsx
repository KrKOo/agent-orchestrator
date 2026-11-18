import { type HarnessModels, isAgentStep, loopRanges, RETRYABLE_STATUSES, type RunStatus, TERMINAL_STATUSES, type Finding, type RunDetail, type WorkspaceInfo } from "@orch/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, ListOrdered, PanelRight, RotateCcw, X } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { ElicitationPanel } from "../components/ElicitationPanel";
import { chatSession, InterventionComposer, InterventionStart } from "../components/InterventionChat";
import { KindIcon, StatusIcon } from "../components/icons";
import { HarnessModelPickers } from "../components/ModelPickers";
import { PermissionPanel } from "../components/PermissionPanel";
import { KIND_LABEL } from "../components/StepPanel";
import { StepResult, Transcript } from "../components/Transcript";
import { useToast } from "../components/Toast";
import { applyRunEvents, initialRunViewState, type LogLine, type StepView } from "../runState";
import { pendingRequest } from "../runRequests";
import {
  Collapsible,
  CopyButton,
  EmptyState,
  formatDuration,
  formatTime,
  githubRefsOf,
  IssueLink,
  LiveAnnouncer,
  Popover,
  PrLink,
  RelativeTime,
  Skeleton,
  StatusChip,
  Tabs,
  useConfirm,
  useDismiss,
  useMediaQuery,
  usePageTitle,
} from "../ui";
import { useRunEventStream } from "../ws";

const EMPTY_STEP: StepView = { status: "pending", items: [], toolCalls: {}, subagents: [] };
/** The sandbox log shows only its newest chunks up to this much text until "Show all". */
const LOG_TAIL_CHARS = 200_000;

type RunTab = "transcript" | "findings" | "log";

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
  /** Session picked in an intervention step's chat (per step, so another gate starts from its own preselection). */
  const [pickedSession, setPickedSession] = useState<{ stepId: string; id: string } | null>(null);
  const [tab, setTab] = useState<RunTab>("transcript");
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** The header's details toggle: excluded from the drawer's outside-click dismissal so it can close it. */
  const detailsToggleRef = useRef<HTMLButtonElement>(null);
  /** Steps drawer (640–1023px only: wider screens show the list as a column, narrower a select). */
  const [stepsOpen, setStepsOpen] = useState(false);
  const wide = useMediaQuery("(min-width: 1024px)");
  const stepsRef = useRef<HTMLDivElement>(null);
  const stepsRefs = useRef([stepsRef]).current;
  useDismiss(stepsOpen && !wide, () => setStepsOpen(false), stepsRefs);
  /** Run error text the callout is dismissed for; a different error makes the callout reappear. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(runId),
    onSuccess: () => toast("Run cancelled", { kind: "success" }),
    onError: (err) => toast(errorMessage(err), { kind: "error" }),
  });
  const approve = useMutation({
    mutationFn: () => api.approveRun(runId),
    onSuccess: () => {
      void detail.refetch();
      toast("Run approved", { kind: "success" });
    },
    onError: (err) => toast(errorMessage(err), { kind: "error" }),
  });
  // A retried run is live again: drop the previous attempt's "Cancelling…" state so it can be cancelled.
  const retry = useMutation({
    mutationFn: (fromStepId: string | undefined) => api.retryRun(runId, fromStepId),
    onSuccess: () => {
      cancel.reset();
      toast("Retry started", { kind: "success" });
    },
    onError: (err) => toast(errorMessage(err), { kind: "error" }),
  });

  // Pick up the final error/timestamps once the stream reports a terminal status.
  useEffect(() => {
    if (terminal) void detail.refetch();
  }, [terminal]);

  // A retry's error belongs to the attempt it targeted; drop it once the run moves on.
  useEffect(() => {
    if (status !== undefined && !RETRYABLE_STATUSES.includes(status)) retry.reset();
  }, [status]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** Transcript items the user missed since scrolling up; "Jump to latest" consumes the count. */
  const [missedCount, setMissedCount] = useState(0);

  const run = detail.data?.run;
  const steps = run?.definition.steps ?? [];
  const selectedId = selected ?? state.currentStepId ?? steps[0]?.id ?? null;
  const step = (selectedId !== null && state.steps[selectedId]) || EMPTY_STEP;
  const stepNameOf = (stepId: string | undefined) => steps.find((s) => s.id === stepId)?.name;
  /** Selecting a step (from the list or the "Waiting for you" banner) closes the steps drawer, revealing the pane. */
  const selectStep = (stepId: string) => {
    setSelected(stepId);
    setStepsOpen(false);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [step, selectedId]);

  // Count items arriving in the selected step while the user has scrolled away from the bottom; "Jump to
  // latest" consumes it. Keyed on the step: another step's longer transcript isn't new arrivals.
  const prevItems = useRef({ stepId: selectedId, count: step.items.length + step.subagents.length });
  useEffect(() => {
    const count = step.items.length + step.subagents.length;
    const prev = prevItems.current;
    prevItems.current = { stepId: selectedId, count };
    if (prev.stepId !== selectedId || count < prev.count) setMissedCount(0); // step switched, or a retry rewound
    else if (count > prev.count && !atBottom.current) setMissedCount((m) => m + count - prev.count);
  }, [step, selectedId]);
  /** First unanswered request (permission > elicitation > intervention), regardless of selection. */
  const pending = pendingRequest(state, submitted);
  /** The docked panel carries its step's name whenever it does not belong to the selected step. */
  const dockStepName =
    pending && pending.request.stepId !== undefined && pending.request.stepId !== selectedId
      ? (stepNameOf(pending.request.stepId) ?? pending.request.stepId)
      : undefined;

  usePageTitle(run ? `Run · ${run.name ?? githubRefsOf(run)[0]?.title ?? run.id.slice(0, 8)}` : "Run");

  // Announce transitions only (not every render): each status change becomes one "Run failed" etc.
  const [announce, setAnnounce] = useState("");
  const prevStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const current = status ?? run?.status;
    if (current !== undefined && current !== prevStatus.current) {
      prevStatus.current = current;
      setAnnounce(`Run ${current.replaceAll("_", " ")}`);
    }
  }, [status, run?.status]);
  // Each new request is announced too: the run stays "running" while a permission or input request
  // waits, and the docked panel doesn't take focus. Declared after the status effect so a request
  // arriving with a status change (awaiting_input) is what gets read out.
  const pendingId = pending?.request.requestId;
  const requestAnnouncement = useRef("");
  useEffect(() => {
    if (!pending) {
      // Answered: drop the stale message so a later identical one ("Permission requested: step x") still
      // changes the live region and is read out.
      setAnnounce((cur) => (cur === requestAnnouncement.current ? "" : cur));
      return;
    }
    const name = stepNameOf(pending.request.stepId) ?? pending.request.stepId;
    const what = pending.kind === "permission" ? "Permission requested" : pending.kind === "elicitation" ? "Input requested" : "Waiting for you";
    requestAnnouncement.current = name ? `${what}: step ${name}` : what;
    setAnnounce(requestAnnouncement.current);
  }, [pendingId]);

  if (detail.error && !run) {
    return (
      <div className="page">
        <EmptyState title="Run not available">{errorMessage(detail.error)}</EmptyState>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="page">
        <Skeleton rows={4} />
      </div>
    );
  }

  const runStatus = status ?? run.status;
  const runTerminal = TERMINAL_STATUSES.includes(runStatus);
  const retryable = RETRYABLE_STATUSES.includes(runStatus);
  const error = state.error ?? run.error ?? undefined;
  const showError = error !== undefined && error !== dismissedError;
  const detailData = detail.data!;
  const stepRows = new Map(detailData.steps.map((s) => [s.stepId, s]));
  const stepStatus = (stepId: string) => state.steps[stepId]?.status ?? stepRows.get(stepId)?.status ?? "pending";
  /** "Run from here" needs every earlier step's output, so it's offered up to the first unfinished step. */
  const firstUnfinished = steps.findIndex((s) => !["succeeded", "skipped"].includes(stepStatus(s.id)));
  // Live stream first; a run that finished before this page opened has no events, so fall back to REST.
  const findings = state.lastSeq > 0 ? state.findings : detailData.findings;
  /** Chat of the selected intervention step while it runs; the latest request carries its sessions. */
  const gateRequest =
    selectedId !== null && state.steps[selectedId]?.status === "running"
      ? state.interventions.findLast((i) => i.stepId === selectedId)
      : undefined;
  const markSubmitted = (requestId: string) => setSubmitted(new Set([...submitted, requestId]));
  /** A chat message was sent: follow the reply as it streams in. */
  const onComposerSubmitted = (requestId: string) => {
    markSubmitted(requestId);
    atBottom.current = true;
  };
  const gateSession = gateRequest && chatSession(gateRequest, pickedSession?.stepId === selectedId ? pickedSession.id : undefined);
  /** First request of the selected intervention step: results as they were when the run paused (kept after it finishes). */
  const gateStart = selectedId !== null ? state.interventions.find((i) => i.stepId === selectedId) : undefined;
  const startSession = gateStart && chatSession(gateStart, gateSession?.id);
  const logs = state.logs.filter((l) => (l.stepId ?? null) === selectedId || l.stepId === undefined);
  const runLevel = state.steps[""];
  const selectedDef = steps.find((s) => s.id === selectedId);
  const selectedRow = selectedId !== null ? stepRows.get(selectedId) : undefined;
  // Live stream first; a reloaded (or already terminal) run falls back to the persisted workspace.
  const workspace = state.workspace ?? run.workspace ?? undefined;
  // Step index → counter of its innermost enclosing loop that has repeated (nested bodies shrink, so smaller
  // ends are inner), or undefined while none has. Same rule as the runner's `step.started` iteration dividers.
  const ranges = loopRanges(run.definition);
  const loopOfStep = (idx: number) =>
    [...ranges]
      .filter(([end, start]) => start <= idx && idx < end)
      .sort(([a], [b]) => a - b)
      .map(([end]) => state.loops[steps[end]!.id])
      .find((c) => c !== undefined);

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setMissedCount(0);
  };
  const askCancel = async () => {
    if (
      await confirm({
        title: "Cancel this run?",
        body: "Queued and running steps are stopped; steps that already finished keep their outputs.",
        confirmLabel: "Cancel run",
        danger: true,
      })
    ) {
      cancel.mutate();
    }
  };

  // The docked slot at the bottom of the pane: the pending request's panel (permission/elicitation), or
  // the selected intervention step's composer. The panel belongs to the run: it shows even when another
  // step is selected, labelled with the step that is asking. It leaves only once answered — no close button.
  const pendingComposer =
    pending?.kind === "intervention" && pending.request.stepId !== undefined ? (
      <InterventionComposer
        key={pending.request.requestId}
        runId={runId}
        stepId={pending.request.stepId}
        request={pending.request}
        session={
          pickedSession?.stepId === pending.request.stepId
            ? chatSession(pending.request, pickedSession.id)
            : chatSession(pending.request, undefined)
        }
        steps={steps}
        stepName={dockStepName}
        awaiting={!pending.request.resolved && !submitted.has(pending.request.requestId)}
        onPick={(id) => setPickedSession({ stepId: pending.request.stepId!, id })}
        onSubmitted={onComposerSubmitted}
      />
    ) : null;
  const dock =
    pending?.kind === "permission" ? (
      <PermissionPanel key={pending.request.requestId} runId={runId} request={pending.request} stepName={dockStepName} onSubmitted={markSubmitted} />
    ) : pending?.kind === "elicitation" ? (
      <ElicitationPanel key={pending.request.requestId} runId={runId} request={pending.request} stepName={dockStepName} onSubmitted={markSubmitted} />
    ) : pendingComposer ?? (gateRequest && selectedId !== null ? (
      <InterventionComposer
        key={selectedId}
        runId={runId}
        stepId={selectedId}
        request={gateRequest}
        session={gateSession}
        steps={steps}
        awaiting={!gateRequest.resolved && !submitted.has(gateRequest.requestId)}
        onPick={(id) => setPickedSession({ stepId: selectedId, id })}
        onSubmitted={onComposerSubmitted}
      />
    ) : null);

  return (
    <div className="run-view">
      <header className="run-header">
        <div className="run-header-row">
          <StatusChip status={runStatus} />
          <h2 className="run-title">
            <Link to={`/flows/${run.flowId}`}>{run.flowName}</Link>
          </h2>
          {(() => {
            // The REST row is authoritative (manual names, first-write-wins); live events only fill a gap.
            const name = run.name ?? state.name;
            if (name) return <span className="run-name">{name}</span>;
            const refs = githubRefsOf(run);
            if (refs.length > 0) {
              return (
                <span className="row gap wrap run-title-refs">
                  {refs.map((ref) => (
                    <IssueLink key={ref.url} githubRef={ref} />
                  ))}
                </span>
              );
            }
            return null;
          })()}
          {run.autoName && !(run.name ?? state.name) && !runTerminal && <span className="muted small">generating name…</span>}
          <span className="mono small muted run-id" title={run.id}>
            {run.id.slice(0, 8)}
          </span>
          <span
            className={`dot ${connected ? "dot-on" : "dot-off"}`}
            role="img"
            aria-label={connected ? "Live" : "Disconnected"}
            title={connected ? "live" : "disconnected"}
          />
          <span className="grow" />
          <button
            ref={detailsToggleRef}
            type="button"
            className="icon-btn"
            aria-label="Run details"
            aria-expanded={detailsOpen}
            title="Run details"
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            <PanelRight size={16} aria-hidden />
          </button>
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
          {retryable && (
            <button
              type="button"
              className="btn primary"
              disabled={retry.isPending}
              title="Re-run the first unfinished step and continue from there (fresh agent session, same workspace)"
              onClick={() => retry.mutate(undefined)}
            >
              {retry.isPending ? "Retrying…" : "Retry"}
            </button>
          )}
          {!runTerminal && (
            <button type="button" className="btn danger" disabled={cancel.isPending || cancel.isSuccess} onClick={() => void askCancel()}>
              {cancel.isSuccess ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
        <div className="run-header-sub small muted">
          <span>
            v{run.flowVersion} · Created <RelativeTime ts={run.createdAt} />
          </span>
          {run.startedAt && (
            <span>
              Started <RelativeTime ts={run.startedAt} />
            </span>
          )}
          {run.finishedAt && (
            <span>
              Finished <RelativeTime ts={run.finishedAt} />
            </span>
          )}
          {run.github && (
            <span>
              PR <PrLink github={run.github} />
            </span>
          )}
        </div>
      </header>
      {showError && (
        <div className="error-callout" role="alert">
          <span className="error-callout-text pre-wrap">{error}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss error" onClick={() => setDismissedError(error!)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
      {pending && (
        <button
          type="button"
          className="request-banner"
          onClick={() => pending.request.stepId !== undefined && selectStep(pending.request.stepId)}
          title="Jump to the step that is waiting"
        >
          Waiting for you — {stepNameOf(pending.request.stepId) ?? pending.request.stepId ?? "this run"}
        </button>
      )}
      <LiveAnnouncer message={announce} />

      <div className="run-body">
        {stepsOpen && !wide && <div className="step-list-backdrop" aria-hidden />}
        <div ref={stepsRef} className={`step-list-wrap${stepsOpen ? " open" : ""}`}>
          <div className="step-list-toolbar">
            <h4 className="step-list-title">Steps</h4>
            <span className="grow" />
            <button type="button" className="icon-btn step-list-close" aria-label="Close steps" onClick={() => setStepsOpen(false)}>
              <X size={16} aria-hidden />
            </button>
          </div>
          <nav className="step-list" aria-label="Run steps">
            {steps.map((s, idx) => {
              const row = stepRows.get(s.id);
              // Once a loop has repeated, its body rows (and the loop row) show which pass is running.
              const loop = s.kind === "loop" ? state.loops[s.id] : loopOfStep(idx);
              return (
                <div key={s.id} className={`step-item ${s.id === selectedId ? "active" : ""}`}>
                  <button type="button" className="step-item-select" onClick={() => selectStep(s.id)}>
                    <span className="step-index">{idx + 1}</span>
                    <KindIcon kind={s.kind} size={14} />
                    <span className="step-item-text">
                      <span className="step-name">{s.name}</span>
                      <span className="step-item-sub">
                        <span className="step-id">{s.id}</span>
                        {row?.startedAt && <span className="muted">{formatDuration(row.startedAt, row.finishedAt)}</span>}
                      </span>
                    </span>
                  </button>
                  {loop && (
                    <span className="tag loop-iter" title="Current pass of the enclosing loop">
                      {loop.iteration}/{loop.maxIterations}
                    </span>
                  )}
                  {retryable && (firstUnfinished < 0 || idx <= firstUnfinished) && (
                    <Popover label={`Step actions for ${s.name}`} button={<Ellipsis size={16} aria-hidden />}>
                      {(close) => (
                        <button
                          type="button"
                          className="menu-item"
                          disabled={retry.isPending}
                          title="Reset this step and everything after, then re-run from here (steps before it keep their outputs)"
                          onClick={() => {
                            close();
                            retry.mutate(s.id);
                          }}
                        >
                          <RotateCcw size={14} aria-hidden /> Run from here
                        </button>
                      )}
                    </Popover>
                  )}
                  <StatusIcon status={stepStatus(s.id)} size={14} />
                </div>
              );
            })}
          </nav>
        </div>
        <div className="run-pane">
          <div className="run-pane-toolbar">
            <button
              type="button"
              className="icon-btn step-list-open"
              aria-label="Show steps"
              aria-expanded={stepsOpen}
              title="Steps"
              onClick={() => setStepsOpen(!stepsOpen)}
            >
              <ListOrdered size={16} aria-hidden />
            </button>
            {/* Below 640px the step list drawer is replaced by this select; both target the same selection. */}
            <select
              className="step-select"
              aria-label="Select step"
              value={selectedId ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {steps.map((s, idx) => (
                <option key={s.id} value={s.id}>
                  {idx + 1}. {s.name}
                </option>
              ))}
            </select>
            <Tabs
              label="Run sections"
              tabs={[
                { id: "transcript", label: "Transcript" },
                { id: "findings", label: `Findings (${findings.length})` },
                { id: "log", label: "Log" },
              ]}
              value={tab}
              onChange={setTab}
            />
          </div>
          {tab === "transcript" && (
            <div
              className="run-main"
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                if (near && missedCount > 0) setMissedCount(0);
                atBottom.current = near;
              }}
            >
              {selectedDef && (
                <div className="step-header">
                  <KindIcon kind={selectedDef.kind} size={18} label={KIND_LABEL[selectedDef.kind]} />
                  <h3>{selectedDef.name}</h3>
                  <span className="step-id">{selectedDef.id}</span>
                  <span className="muted small">{KIND_LABEL[selectedDef.kind]}</span>
                  <span className="grow" />
                  {(() => {
                    // The loop step shows its own counter; body steps their enclosing loop's.
                    const idx = steps.indexOf(selectedDef);
                    const loop = selectedDef.kind === "loop" ? state.loops[selectedDef.id] : idx >= 0 ? loopOfStep(idx) : undefined;
                    return loop ? (
                      <span className="tag loop-iter" title="Current pass of the enclosing loop">
                        {loop.iteration}/{loop.maxIterations}
                      </span>
                    ) : null;
                  })()}
                  {selectedRow?.startedAt && <span className="muted small">{formatDuration(selectedRow.startedAt, selectedRow.finishedAt)}</span>}
                  <StatusIcon status={state.steps[selectedDef.id]?.status ?? selectedRow?.status ?? "pending"} size={14} />
                </div>
              )}
              {step.items.length === 0 && step.subagents.length === 0 && step.output === undefined && !step.error && !gateRequest && (
                <p className="muted">
                  {step.status === "pending" ? "Step has not started." : step.status === "skipped" ? "Skipped: the run bypassed this step." : "Waiting for output…"}
                </p>
              )}
              {gateStart?.message && <p className="intervention-note pre-wrap">{gateStart.message}</p>}
              {startSession && <InterventionStart session={startSession} />}
              <Transcript step={step} />
              {selectedDef && (
                <StepResult
                  step={step}
                  // Condition steps, like loops, produce no template value for later steps.
                  stepId={selectedDef.kind === "loop" || selectedDef.kind === "condition" ? undefined : selectedDef.id}
                  markdown={isAgentStep(selectedDef) || selectedDef.kind === "slash"}
                  mono={selectedDef.kind === "shell"}
                  // The latest request holds the pick (chat turns and earlier loop passes resolve earlier ones); only
                  // a finished attempt shows it, so a gate reset by a loop repeat or retry shows no stale pick.
                  gate={selectedDef.kind === "intervention" && step.status === "succeeded" ? state.interventions.findLast((i) => i.stepId === selectedDef.id) : undefined}
                />
              )}
              {runLevel && runLevel.items.length > 0 && (
                <Collapsible summary="Run-level updates" className="diagnostics">
                  <Transcript step={runLevel} />
                </Collapsible>
              )}
              {missedCount > 0 && (
                <div className="jump-latest-wrap">
                  <button type="button" className="jump-latest" onClick={jumpToLatest}>
                    Jump to latest ({missedCount} new)
                  </button>
                </div>
              )}
            </div>
          )}
          {tab === "findings" && (
            <div className="run-main">
              <FindingsTable findings={findings} />
            </div>
          )}
          {tab === "log" && (
            <div className="run-main">
              {logs.length > 0 ? <SandboxLog logs={logs} /> : <p className="muted">No sandbox log for this step.</p>}
            </div>
          )}
          {dock}
        </div>
        <RunDetails
          open={detailsOpen}
          dismissable={!wide}
          toggleRef={detailsToggleRef}
          run={run}
          status={status ?? run.status}
          workspace={workspace}
          onClose={() => setDetailsOpen(false)}
        />
      </div>
      {confirmDialog}
    </div>
  );
}

/** The Findings tab: one row per MCP `report_finding`, with severity chip and template-free location. */
function FindingsTable({ findings }: { findings: (Finding & { stepId?: string })[] }) {
  if (findings.length === 0) {
    return <EmptyState title="No findings">Nothing has been reported as a finding so far.</EmptyState>;
  }
  return (
    <table className="table compact findings-table">
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
  );
}

/**
 * Run details side panel: a right column next to the run body on wide screens, an overlay drawer
 * (`dismissable`: closes on Escape or outside pointer-down) below 1024px. Toggled from the header's PanelRight button.
 */
function RunDetails({
  open,
  dismissable,
  toggleRef,
  run,
  status,
  workspace,
  onClose,
}: {
  open: boolean;
  dismissable: boolean;
  /** The button that toggles the panel; a pointer-down on it must not count as "outside". */
  toggleRef: RefObject<HTMLButtonElement | null>;
  run: RunDetail["run"];
  /** Live status (the event stream's, else the fetched run's). */
  status: RunStatus;
  workspace: WorkspaceInfo | undefined;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const refs = useRef([panelRef, toggleRef]).current;
  useDismiss(open && dismissable, onClose, refs);
  if (!open) return null;
  return (
    <aside ref={panelRef} className="run-details" aria-label="Run details">
      <div className="run-details-head">
        <h3>Details</h3>
        <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="run-details-body small">
        <div className="detail-row">
          <span className="detail-label">Runner</span>
          {run.runnerId ? <span className="mono">{run.runnerId}</span> : <span className="muted">—</span>}
        </div>
        <RunModels run={run} status={status} />
        <div className="detail-row">
          <span className="detail-label">Workspace</span>
          {workspace ? (
            <div className="row gap-tight wrap">
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
            </div>
          ) : (
            <span className="muted">preparing…</span>
          )}
        </div>
        <div className="detail-row">
          <span className="detail-label">Inputs</span>
          {Object.keys(run.inputs).length > 0 ? <pre>{JSON.stringify(run.inputs, null, 2)}</pre> : <span className="muted">none</span>}
        </div>
        <div className="detail-row">
          <span className="detail-label">Refs</span>
          {(() => {
            const refs = githubRefsOf(run);
            // The PR the run is attached to is already linked in the header; list the rest here.
            const others = refs.filter((ref) => !(run.github && ref.kind === "pull_request" && ref.repo === run.github.repo && ref.number === run.github.number));
            if (!run.github && others.length === 0) return <span className="muted">none</span>;
            return (
              <div className="row gap wrap">
                {run.github && <PrLink github={run.github} />}
                {others.map((ref) => (
                  <IssueLink key={ref.url} githubRef={ref} />
                ))}
              </div>
            );
          })()}
        </div>
        {/* Absolute times here; the header line has the relative ones. */}
        <div className="detail-row">
          <span className="detail-label">Created</span>
          <span>{formatTime(run.createdAt)}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Started</span>
          {run.startedAt ? <span>{formatTime(run.startedAt)}</span> : <span className="muted">—</span>}
        </div>
        <div className="detail-row">
          <span className="detail-label">Finished</span>
          {run.finishedAt ? <span>{formatTime(run.finishedAt)}</span> : <span className="muted">—</span>}
        </div>
        <div className="detail-row">
          <span className="detail-label">Trust</span>
          {run.trust === "owner" ? (
            <span className="tag">owner</span>
          ) : (
            <span className="tag warn" title="Untrusted runs go to runners that opt in; no local workspaces, restricted network">
              untrusted
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * The run's harness models, switchable until it succeeds: a running run switches at once (or from its next agent
 * turn when the harness must restart), a queued one starts with them, a failed or cancelled one retries with them.
 */
function RunModels({ run, status }: { run: RunDetail["run"]; status: RunStatus }) {
  const { id: _, ...saved } = run.definition.harness;
  /** Models being edited; null while showing the saved ones. */
  const [draft, setDraft] = useState<HarnessModels | null>(null);
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, enabled: draft !== null });
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (models: HarnessModels) => api.setRunModels(run.id, models),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ["run", run.id] });
      toast("Models switched", { kind: "success" });
    },
    onError: (err) => toast(errorMessage(err), { kind: "error" }),
  });
  const roles: [string, string][] = [
    ["default", saved.model],
    ["smol", saved.smolModel ?? saved.model],
    ...Object.entries(saved.modelRoles ?? {}),
  ];
  return (
    <div className="detail-row">
      <span className="detail-label">Models</span>
      {draft === null ? (
        <div className="run-models">
          {roles.map(([role, model]) => (
            <div key={role} className="row gap-tight">
              <span className="muted">{role}</span>
              <span className="mono">{model}</span>
            </div>
          ))}
          {status !== "succeeded" && (
            <div>
              <button type="button" className="btn small" onClick={() => setDraft(saved)}>
                Switch models
              </button>
            </div>
          )}
        </div>
      ) : (
        <form
          className="run-models"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(draft);
          }}
        >
          <HarnessModelPickers value={draft} models={catalog.data?.models ?? []} onChange={setDraft} />
          <div className="row gap">
            <button type="submit" className="btn small primary" disabled={save.isPending || draft.model.trim() === ""}>
              {save.isPending ? "Switching…" : "Switch"}
            </button>
            <button type="button" className="btn small" disabled={save.isPending} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Log chunks as one `<pre>`; long logs (a chatty shell step) show their tail first. */
function SandboxLog({ logs }: { logs: LogLine[] }) {
  const [all, setAll] = useState(false);
  // Newest chunks within the budget, and always at least the last one.
  let start = 0;
  if (!all && logs.length > 0) {
    start = logs.length - 1;
    let chars = logs[start]!.text.length;
    while (start > 0 && chars + logs[start - 1]!.text.length <= LOG_TAIL_CHARS) {
      start--;
      chars += logs[start]!.text.length;
    }
  }
  return (
    <>
      {start > 0 && (
        <div className="row gap muted">
          <span>
            Showing the last {(logs.length - start).toLocaleString()} of {logs.length.toLocaleString()} chunks
          </span>
          <button type="button" className="btn small" onClick={() => setAll(true)}>
            Show all
          </button>
        </div>
      )}
      <pre className="log">
        {logs.slice(start).map((l) => (
          <span key={l.seq} className={l.stream === "stderr" ? "log-err" : undefined}>
            {l.text.endsWith("\n") ? l.text : `${l.text}\n`}
          </span>
        ))}
      </pre>
    </>
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
