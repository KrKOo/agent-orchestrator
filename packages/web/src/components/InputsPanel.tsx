import type { FlowDefinition, InputDef } from "@orch/protocol";
import { useEffect, useState } from "react";
import { PathPicker } from "./PathPicker";

/** Editor for flow-level settings: inputs, workspace, sandbox network, harness, approval, runner labels. */
export function InputsPanel({
  def,
  errors,
  onChange,
}: {
  def: FlowDefinition;
  errors: string[];
  onChange: (def: FlowDefinition) => void;
}) {
  const [picking, setPicking] = useState(false);
  const ws = def.workspace;
  const net = def.sandbox.network;
  const setInput = (idx: number, patch: Partial<InputDef>) =>
    onChange({ ...def, inputs: def.inputs.map((i, n) => (n === idx ? { ...i, ...patch } : i)) });
  const setWorkspace = (patch: Partial<FlowDefinition["workspace"]>) =>
    onChange({ ...def, workspace: { ...ws, ...patch } });
  const setNetwork = (patch: Partial<FlowDefinition["sandbox"]["network"]>) =>
    onChange({ ...def, sandbox: { ...def.sandbox, network: { ...net, ...patch } } });

  return (
    <div className="panel-body">
      <div className="panel-title">
        <span className="kind-icon">⚙</span>
        <h3>Inputs &amp; Workspace</h3>
      </div>
      {errors.length > 0 && (
        <ul className="error-list">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <section>
        <h4>Inputs</h4>
        {def.inputs.length === 0 && <p className="muted small">No inputs. Reference inputs as {"{{inputs.<key>}}"}.</p>}
        {def.inputs.map((input, idx) => (
          <div key={idx} className="input-row">
            <input
              className="mono"
              placeholder="key"
              value={input.key}
              onChange={(e) => setInput(idx, { key: e.target.value })}
            />
            <input placeholder="label" value={input.label} onChange={(e) => setInput(idx, { label: e.target.value })} />
            <select
              value={input.type}
              onChange={(e) => setInput(idx, { type: e.target.value as InputDef["type"] })}
            >
              <option value="text">text</option>
              <option value="github_issue">github_issue</option>
            </select>
            <label className="check" title="Required">
              <input
                type="checkbox"
                checked={input.required}
                onChange={(e) => setInput(idx, { required: e.target.checked })}
              />
              req
            </label>
            <button
              type="button"
              className="icon-btn"
              aria-label="Remove input"
              onClick={() => onChange({ ...def, inputs: def.inputs.filter((_, n) => n !== idx) })}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn small"
          onClick={() =>
            onChange({
              ...def,
              inputs: [...def.inputs, { key: `input_${def.inputs.length + 1}`, label: "", type: "text", required: true }],
            })
          }
        >
          + Add input
        </button>
      </section>

      <section>
        <h4>Workspace</h4>
        <label className="field">
          <span>Local path (on the runner)</span>
          <div className="row gap">
            <input
              className="mono grow"
              placeholder="/absolute/path/to/repo"
              value={ws.path}
              onChange={(e) => setWorkspace({ path: e.target.value })}
            />
            <button type="button" className="btn small" onClick={() => setPicking(true)}>
              Browse…
            </button>
          </div>
        </label>
        <div className="grid3">
          <label className="field">
            <span>Isolation</span>
            <select
              value={ws.isolation}
              onChange={(e) => setWorkspace({ isolation: e.target.value as typeof ws.isolation })}
            >
              <option value="worktree">worktree</option>
              <option value="direct">direct</option>
            </select>
          </label>
          <label className="field">
            <span>Base ref</span>
            <input className="mono" value={ws.baseRef} onChange={(e) => setWorkspace({ baseRef: e.target.value })} />
          </label>
          <label className="field">
            <span>Access</span>
            <select value={ws.access} onChange={(e) => setWorkspace({ access: e.target.value as typeof ws.access })}>
              <option value="rw">read-write</option>
              <option value="ro">read-only</option>
            </select>
          </label>
        </div>
      </section>

      <section>
        <h4>Sandbox</h4>
        <label className="field">
          <span>Network</span>
          <select value={net.mode} onChange={(e) => setNetwork({ mode: e.target.value as typeof net.mode })}>
            <option value="gateway_only">gateway only (model calls)</option>
            <option value="allowlist">allowlist</option>
            <option value="open">open (any http/https)</option>
          </select>
        </label>
        {net.mode === "allowlist" && (
          <label className="field">
            <span>Allowed domains (one per line; leading “.” includes subdomains)</span>
            <ListField multiline value={net.allow} onChange={(allow) => setNetwork({ allow })} />
          </label>
        )}
      </section>

      <section>
        <h4>Harness</h4>
        <div className="grid2">
          <label className="field">
            <span>Model</span>
            <input
              className="mono"
              value={def.harness.model}
              onChange={(e) => onChange({ ...def, harness: { ...def.harness, model: e.target.value } })}
            />
          </label>
          <label className="field">
            <span>Small model (optional)</span>
            <input
              className="mono"
              value={def.harness.smolModel ?? ""}
              onChange={(e) =>
                onChange({
                  ...def,
                  harness: { ...def.harness, smolModel: e.target.value === "" ? undefined : e.target.value },
                })
              }
            />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Tool approval</span>
            <select
              value={def.approval}
              onChange={(e) => onChange({ ...def, approval: e.target.value as FlowDefinition["approval"] })}
            >
              <option value="auto">auto (no prompts)</option>
              <option value="ask">ask (approve in run view)</option>
            </select>
          </label>
          <label className="field">
            <span>Runner labels (comma separated)</span>
            <ListField value={def.runnerLabels} onChange={(runnerLabels) => onChange({ ...def, runnerLabels })} />
          </label>
        </div>
      </section>

      {picking && (
        <PathPicker
          initialPath={ws.path}
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setWorkspace({ path });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** Edits a string list as text (comma or newline separated) without eating separators while typing. */
function ListField({
  value,
  multiline,
  onChange,
}: {
  value: string[];
  multiline?: boolean;
  onChange: (value: string[]) => void;
}) {
  const sep = multiline ? "\n" : ",";
  const parse = (text: string) =>
    text
      .split(sep)
      .map((l) => l.trim())
      .filter(Boolean);
  const [text, setText] = useState(value.join(multiline ? "\n" : ", "));
  // Resync when the list changes from outside (e.g. the JSON tab).
  useEffect(() => {
    if (parse(text).join("\u0000") !== value.join("\u0000")) setText(value.join(multiline ? "\n" : ", "));
  }, [value]);
  const update = (next: string) => {
    setText(next);
    onChange(parse(next));
  };
  return multiline ? (
    <textarea className="mono" rows={3} value={text} onChange={(e) => update(e.target.value)} />
  ) : (
    <input value={text} onChange={(e) => update(e.target.value)} />
  );
}
