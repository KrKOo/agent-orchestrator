// Start-a-run dialog: optional run name, then the flow's declared inputs. Shared by the Flows list and the editor.
import { flowBindings, type FlowRow, type InputDef, isGitHubInput, RUN_NAME_MAX } from "@orch/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { api, ApiRequestError, errorMessage } from "../api";
import { initialInputValue } from "../runInputs";
import { Modal } from "../ui";
import { ModelSelect } from "./ModelPickers";
import { PathPicker } from "./PathPicker";
import { useToast } from "./Toast";

/**
 * A required input the user has to fill in: GitHub inputs always, value inputs only without a default (the server
 * applies a default, `0` and `false` included, before its required check).
 */
function mustFill(d: InputDef): boolean {
  return d.required && (isGitHubInput(d) || d.default === undefined || d.default === "");
}

export function RunDialog({ flow, onClose }: { flow: FlowRow; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const defs = flow.definition.inputs;
  const bindings = flowBindings(flow.definition);
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, enabled: defs.some((d) => d.type === "model") });
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(defs.map((d) => [d.key, initialInputValue(d, bindings)])),
  );
  /** Key of the path input whose directory picker is open. */
  const [picking, setPicking] = useState<string | null>(null);
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
  const missing = defs.filter((d) => mustFill(d) && !values[d.key]?.trim());
  const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));

  const control = (d: InputDef): ReactNode => {
    const value = values[d.key] ?? "";
    switch (d.type) {
      case "text":
        return <textarea rows={3} required={mustFill(d)} value={value} onChange={(e) => set(d.key, e.target.value)} />;
      case "select":
        return (
          <select required={mustFill(d)} value={value} onChange={(e) => set(d.key, e.target.value)}>
            {(!mustFill(d) || value === "") && <option value="">—</option>}
            {d.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label || o.value}
              </option>
            ))}
          </select>
        );
      case "path":
        return (
          <div className="row gap">
            <input
              className="mono grow"
              required={mustFill(d)}
              placeholder="/absolute/path"
              value={value}
              onChange={(e) => set(d.key, e.target.value)}
            />
            <button type="button" className="btn small" onClick={() => setPicking(d.key)}>
              Browse…
            </button>
          </div>
        );
      case "number":
        return <input type="number" step="any" required={mustFill(d)} value={value} onChange={(e) => set(d.key, e.target.value)} />;
      case "github_issue":
      case "github_pull_request":
        return (
          <input
            type="url"
            required={mustFill(d)}
            placeholder={
              d.type === "github_pull_request" ? "https://github.com/owner/repo/pull/123" : "https://github.com/owner/repo/issues/123"
            }
            value={value}
            onChange={(e) => set(d.key, e.target.value)}
          />
        );
      // model and boolean render their own field below.
      default:
        return null;
    }
  };

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
        {defs.map((d) => {
          const label = d.label || d.key;
          const sets = bindings.filter((b) => b.key === d.key).map((b) => b.path);
          const hint = sets.length > 0 ? <small className="muted">sets {sets.join(", ")}</small> : undefined;
          // Empty: each bound field keeps its own value (or the input's default applies).
          const emptyLabel = sets.length > 1 ? "— keep each field's own value —" : "—";
          if (d.type === "model") {
            return (
              <ModelSelect
                key={d.key}
                label={d.required ? `${label} *` : label}
                value={values[d.key] ?? ""}
                models={catalog.data?.models ?? []}
                extra={hint}
                emptyLabel={mustFill(d) ? undefined : emptyLabel}
                onChange={(model) => set(d.key, model)}
              />
            );
          }
          // A checkbox cannot show or return to the empty state an input starts in when it sets several fields.
          if (d.type === "boolean" && initialInputValue(d, bindings) === "") {
            return (
              <label key={d.key} className="field">
                <span>
                  {label} {d.required && <span aria-label="required">*</span>}
                </span>
                <select required={mustFill(d)} value={values[d.key] ?? ""} onChange={(e) => set(d.key, e.target.value)}>
                  <option value="">{emptyLabel}</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
                {hint}
              </label>
            );
          }
          if (d.type === "boolean") {
            return (
              <div key={d.key} className="field">
                <label className="check inline-check">
                  <input type="checkbox" checked={values[d.key] === "true"} onChange={(e) => set(d.key, String(e.target.checked))} />
                  {label}
                </label>
                {hint}
              </div>
            );
          }
          return (
            <label key={d.key} className="field">
              <span>
                {label} {d.required && <span aria-label="required">*</span>}
              </span>
              {control(d)}
              {hint}
            </label>
          );
        })}
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
            {start.error instanceof ApiRequestError && start.error.errors.length > 1
              ? start.error.errors.join("; ")
              : errorMessage(start.error)}
          </p>
        )}
      </form>
      {picking !== null && (
        <PathPicker
          initialPath={values[picking] ?? ""}
          onClose={() => setPicking(null)}
          onSelect={(path) => {
            set(picking, path);
            setPicking(null);
          }}
        />
      )}
    </Modal>
  );
}
