// Start-a-run dialog: optional run name, then the flow's declared inputs. Shared by the Flows list and the editor.
import { type FlowRow, RUN_NAME_MAX } from "@orch/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, errorMessage } from "../api";
import { Modal } from "../ui";
import { useToast } from "./Toast";

export function RunDialog({ flow, onClose }: { flow: FlowRow; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const defs = flow.definition.inputs;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(defs.map((d) => [d.key, ""])));
  const [name, setName] = useState("");
  const [autoName, setAutoName] = useState(false);
  const start = useMutation({
    mutationFn: () => api.startRun(flow.id, values, autoName ? { autoName: true } : name.trim() ? { name: name.trim() } : {}),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      toast(`Run started: ${flow.name}`, { kind: "success" });
      navigate(`/runs/${run.id}`);
    },
  });
  const missing = defs.filter((d) => d.required && !values[d.key]?.trim());

  return (
    <Modal
      title={`Run “${flow.name}”`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="run-dialog-form" className="btn primary" disabled={missing.length > 0 || start.isPending}>
            {start.isPending ? "Starting…" : "Start run"}
          </button>
        </>
      }
    >
      <form
        id="run-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.length === 0 && !start.isPending) start.mutate();
        }}
      >
        {/* Inputs first: they are what the run needs; the name is optional. */}
        {defs.length === 0 && <p className="muted">This flow has no inputs.</p>}
        {defs.map((d) => (
          <label key={d.key} className="field">
            <span>
              {d.label || d.key} {d.required && <span aria-label="required">*</span>}
            </span>
            {d.type === "text" ? (
              <textarea
                rows={3}
                required={d.required}
                value={values[d.key] ?? ""}
                onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}
              />
            ) : (
              <input
                type="url"
                required={d.required}
                placeholder={
                  d.type === "github_pull_request" ? "https://github.com/owner/repo/pull/123" : "https://github.com/owner/repo/issues/123"
                }
                value={values[d.key] ?? ""}
                onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}
              />
            )}
          </label>
        ))}
        <label className="field">
          <span>Run name</span>
          <input
            type="text"
            placeholder="Optional — shown on the Runs page"
            maxLength={RUN_NAME_MAX}
            value={autoName ? "" : name}
            disabled={autoName}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field inline">
          <input type="checkbox" checked={autoName} onChange={(e) => setAutoName(e.target.checked)} />
          <span>Generate the name with an agent from the inputs</span>
        </label>
        {start.error && (
          <p className="error" role="alert">
            {errorMessage(start.error)}
          </p>
        )}
      </form>
    </Modal>
  );
}
