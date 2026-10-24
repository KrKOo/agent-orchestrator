import { type InterventionAction, type Step } from "@orch/protocol";
import { useState } from "react";
import { api, errorMessage } from "../api";
import type { InterventionView } from "../runState";
import { Modal } from "../ui";

interface AddedStep {
  kind: "prompt" | "slash";
  id: string;
  name: string;
  prompt?: string;
  command?: string;
  args?: string;
}

const ID_RE = /^[a-z][a-z0-9_]*$/;

/** Review gate: continue (optionally with feedback and extra prompt/slash steps) or cancel the step. */
export function InterventionDialog({
  runId,
  request,
  variables,
  onSubmitted,
  onClose,
}: {
  runId: string;
  request: InterventionView;
  /** Template variables available to injected steps (paths of the flow at the gate). */
  variables: { path: string; description: string }[];
  onSubmitted: (requestId: string) => void;
  onClose: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [added, setAdded] = useState<AddedStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (i: number, p: Partial<AddedStep>) => setAdded(added.map((s, j) => (j === i ? { ...s, ...p } : s)));

  const respond = async (action: InterventionAction) => {
    setBusy(true);
    setError(null);
    try {
      const steps = added.map((s, i): Step =>
        s.kind === "prompt"
          ? { id: s.id, name: s.name || `Step ${i + 1}`, kind: "prompt", prompt: s.prompt ?? "", freshSession: false, timeoutSec: 1800 }
          : { id: s.id, name: s.name || `Step ${i + 1}`, kind: "slash", command: s.command ?? "", ...(s.args ? { args: s.args } : {}), timeoutSec: 1800 },
      );
      await api.respondIntervention(runId, request.requestId, {
        stepId: request.stepId ?? "",
        action,
        ...(feedback ? { feedback } : {}),
        ...(action === "continue" && steps.length ? { steps } : {}),
      });
      onSubmitted(request.requestId);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const invalidIds = added.filter((s) => !ID_RE.test(s.id) || added.filter((o) => o.id === s.id).length > 1);

  return (
    <Modal
      title="Waiting for your review"
      onClose={onClose}
      footer={
      <>
        <button type="button" className="btn danger" disabled={busy} onClick={() => respond("cancel")}>
          Cancel step
        </button>
        <button type="button" className="btn primary" disabled={busy || invalidIds.length > 0} onClick={() => respond("continue")}>
          Continue
        </button>
      </>
    }>
      <p>
        {request.message ? <span className="pre-wrap">{request.message}</span> : <span className="muted">No reviewer note.</span>}
        {request.stepId && (
          <>
            {" "}
            <span className="muted small">
              step <span className="mono">{request.stepId}</span>
            </span>
          </>
        )}
      </p>
      <div className="field">
        <label htmlFor="intervention-feedback">Feedback (becomes this step's output)</label>
        <textarea
          id="intervention-feedback"
          rows={4}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Later steps can reference {{steps.<gate>.output}}"
        />
      </div>
      <div className="field">
        <span>Add steps (run after this gate)</span>
        {added.map((s, i) => (
          <div key={i} className="row gap wrap">
            <select value={s.kind} onChange={(e) => patch(i, { kind: e.target.value as AddedStep["kind"] })}>
              <option value="prompt">Prompt</option>
              <option value="slash">Slash command</option>
            </select>
            <input className="mono" placeholder="step_id" value={s.id} onChange={(e) => patch(i, { id: e.target.value })} />
            {s.kind === "prompt" ? (
              <textarea
                rows={2}
                placeholder="Prompt for the agent"
                value={s.prompt ?? ""}
                onChange={(e) => patch(i, { prompt: e.target.value })}
              />
            ) : (
              <>
                <input
                  className="mono"
                  placeholder="command (e.g. review)"
                  value={s.command ?? ""}
                  onChange={(e) => patch(i, { command: e.target.value })}
                />
                <input
                  className="mono"
                  placeholder="args (optional)"
                  value={s.args ?? ""}
                  onChange={(e) => patch(i, { args: e.target.value })}
                />
              </>
            )}
            <button type="button" className="icon-btn" aria-label="Remove step" onClick={() => setAdded(added.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="btn small" onClick={() => setAdded([...added, { kind: "prompt", id: "", name: "" }])}>
          Add step
        </button>
        {variables.length > 0 && (
          <details className="template-vars">
            <summary className="muted small">Template variables</summary>
            {variables.map((v) => (
              <div key={v.path} className="small">
                <code className="mono">{`{{${v.path}}}`}</code> <span className="muted">{v.description}</span>
              </div>
            ))}
          </details>
        )}
        {invalidIds.length > 0 && <p className="error">Step ids must be unique and match /^[a-z][a-z0-9_]*$/.</p>}
      </div>
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
