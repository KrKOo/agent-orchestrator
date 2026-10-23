import {
  type FlowDefinition,
  type GitHubPullRequestTrigger,
  type InputDef,
  type LocalPathWorkspace,
  PR_EVENTS,
  PR_INPUT_FIELDS,
  type PrEvent,
} from "@orch/protocol";
import { useEffect, useState } from "react";
import { PathPicker } from "./PathPicker";

export const DEFAULT_LOCAL_WORKSPACE: LocalPathWorkspace = {
  kind: "local_path",
  path: "",
  isolation: "worktree",
  baseRef: "HEAD",
  access: "rw",
};

const FORK_POLICY_LABEL: Record<GitHubPullRequestTrigger["forkPolicy"], string> = {
  skip: "skip (never run)",
  require_approval: "require approval in the UI",
  run: "run automatically",
};

/**
 * Switches the trigger kind. Pull request flows get the PR checkout workspace, no inputs (the PR arrives as
 * `inputs.pr`) and auto approval; returning to manual restores a local workspace.
 */
function withTrigger(def: FlowDefinition, kind: FlowDefinition["trigger"]["kind"]): FlowDefinition {
  if (kind === def.trigger.kind) return def;
  if (kind === "manual") {
    return {
      ...def,
      trigger: { kind: "manual" },
      workspace: def.workspace.kind === "local_path" ? def.workspace : DEFAULT_LOCAL_WORKSPACE,
    };
  }
  return {
    ...def,
    trigger: {
      kind: "github_pull_request",
      repos: [],
      events: [...PR_EVENTS],
      forkPolicy: "require_approval",
      postReview: true,
    },
    workspace: { kind: "github_checkout" },
    inputs: [],
    approval: "auto",
  };
}

/** Editor for flow-level settings: trigger, inputs, workspace, sandbox network, harness, approval, runner labels. */
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
  const trigger = def.trigger;
  const prFlow = trigger.kind === "github_pull_request";
  const setInput = (idx: number, patch: Partial<InputDef>) =>
    onChange({ ...def, inputs: def.inputs.map((i, n) => (n === idx ? { ...i, ...patch } : i)) });
  const setLocal = (patch: Partial<LocalPathWorkspace>) =>
    onChange({ ...def, workspace: { ...(ws.kind === "local_path" ? ws : DEFAULT_LOCAL_WORKSPACE), ...patch } });
  const setPr = (patch: Partial<GitHubPullRequestTrigger>) => {
    if (trigger.kind === "github_pull_request") onChange({ ...def, trigger: { ...trigger, ...patch } });
  };
  const setNetwork = (patch: Partial<FlowDefinition["sandbox"]["network"]>) =>
    onChange({ ...def, sandbox: { ...def.sandbox, network: { ...net, ...patch } } });

  return (
    <div className="panel-body">
      <div className="panel-title">
        <span className="kind-icon">⚙</span>
        <h3>Trigger, Inputs &amp; Workspace</h3>
      </div>
      {errors.length > 0 && (
        <ul className="error-list">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <section>
        <h4>Trigger</h4>
        <label className="field">
          <span>Runs start</span>
          <select
            aria-label="Trigger kind"
            value={trigger.kind}
            onChange={(e) => onChange(withTrigger(def, e.target.value as FlowDefinition["trigger"]["kind"]))}
          >
            <option value="manual">manually (Run… button)</option>
            <option value="github_pull_request">on GitHub pull request events</option>
          </select>
        </label>
        {trigger.kind === "github_pull_request" && (
          <>
            <label className="field">
              <span>Repositories (owner/name, one per line)</span>
              <ListField multiline value={trigger.repos} onChange={(repos) => setPr({ repos })} />
            </label>
            <div className="field">
              <span>Events</span>
              <div className="row gap wrap">
                {PR_EVENTS.map((ev) => (
                  <label key={ev} className="check inline-check">
                    <input
                      type="checkbox"
                      checked={trigger.events.includes(ev)}
                      onChange={(e) =>
                        setPr({
                          events: PR_EVENTS.filter((x: PrEvent) =>
                            x === ev ? e.target.checked : trigger.events.includes(x),
                          ),
                        })
                      }
                    />
                    <span className="mono">{ev}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="grid2">
              <label className="field">
                <span>Fork / first-time contributor PRs</span>
                <select
                  value={trigger.forkPolicy}
                  onChange={(e) => setPr({ forkPolicy: e.target.value as GitHubPullRequestTrigger["forkPolicy"] })}
                >
                  {Object.entries(FORK_POLICY_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Check run name</span>
                <input
                  placeholder={def.name}
                  value={trigger.checkName ?? ""}
                  onChange={(e) => setPr({ checkName: e.target.value === "" ? undefined : e.target.value })}
                />
              </label>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={trigger.postReview}
                onChange={(e) => setPr({ postReview: e.target.checked })}
              />
              Post a review with inline comments for findings
            </label>
          </>
        )}
      </section>

      <section>
        <h4>Inputs</h4>
        {prFlow ? (
          <>
            <p className="muted small">The pull request is supplied automatically. Template variables:</p>
            <ul className="hint-list mono small">
              {PR_INPUT_FIELDS.map((f) => (
                <li key={f}>{`{{inputs.pr.${f}}}`}</li>
              ))}
            </ul>
            <p className="muted small">
              <span className="mono">title</span> and <span className="mono">body</span> arrive wrapped in{" "}
              <span className="mono">&lt;untrusted_pr_text&gt;</span>; the diff is at{" "}
              <span className="mono">inputs.pr.diffPath</span>.
            </p>
            {def.inputs.length > 0 && (
              <button type="button" className="btn small danger" onClick={() => onChange({ ...def, inputs: [] })}>
                Remove {def.inputs.length} declared {def.inputs.length === 1 ? "input" : "inputs"}
              </button>
            )}
          </>
        ) : (
          <>
            {def.inputs.length === 0 && (
              <p className="muted small">No inputs. Reference inputs as {"{{inputs.<key>}}"}.</p>
            )}
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
                  inputs: [
                    ...def.inputs,
                    { key: `input_${def.inputs.length + 1}`, label: "", type: "text", required: true },
                  ],
                })
              }
            >
              + Add input
            </button>
          </>
        )}
      </section>

      <section>
        <h4>Workspace</h4>
        <label className="field">
          <span>Kind</span>
          <select
            aria-label="Workspace kind"
            value={ws.kind}
            onChange={(e) =>
              onChange({
                ...def,
                workspace: e.target.value === "github_checkout" ? { kind: "github_checkout" } : DEFAULT_LOCAL_WORKSPACE,
              })
            }
          >
            <option value="local_path">local path on the runner</option>
            <option value="github_checkout">pull request checkout (read-only)</option>
          </select>
        </label>
        {ws.kind === "github_checkout" ? (
          <p className="muted small">
            The runner checks out the PR head on the host and mounts it read-only; the diff against the base is at{" "}
            <span className="mono">/orch/context/pr.diff</span>.
          </p>
        ) : (
          <>
            <label className="field">
              <span>Local path (on the runner)</span>
              <div className="row gap">
                <input
                  className="mono grow"
                  placeholder="/absolute/path/to/repo"
                  value={ws.path}
                  onChange={(e) => setLocal({ path: e.target.value })}
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
                  onChange={(e) => setLocal({ isolation: e.target.value as LocalPathWorkspace["isolation"] })}
                >
                  <option value="worktree">worktree</option>
                  <option value="direct">direct</option>
                </select>
              </label>
              <label className="field">
                <span>Base ref</span>
                <input className="mono" value={ws.baseRef} onChange={(e) => setLocal({ baseRef: e.target.value })} />
              </label>
              <label className="field">
                <span>Access</span>
                <select
                  value={ws.access}
                  onChange={(e) => setLocal({ access: e.target.value as LocalPathWorkspace["access"] })}
                >
                  <option value="rw">read-write</option>
                  <option value="ro">read-only</option>
                </select>
              </label>
            </div>
          </>
        )}
      </section>

      <section>
        <h4>Sandbox</h4>
        <label className="field">
          <span>Network</span>
          <select value={net.mode} onChange={(e) => setNetwork({ mode: e.target.value as typeof net.mode })}>
            <option value="gateway_only">gateway only (model calls)</option>
            <option value="allowlist">allowlist</option>
            <option value="open" disabled={prFlow}>
              open (any http/https){prFlow ? " — not allowed for pull request flows" : ""}
            </option>
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
              <option value="ask" disabled={prFlow}>
                ask (approve in run view){prFlow ? " — not allowed for pull request flows" : ""}
              </option>
            </select>
          </label>
          <label className="field">
            <span>Runner labels (comma separated)</span>
            <ListField value={def.runnerLabels} onChange={(runnerLabels) => onChange({ ...def, runnerLabels })} />
          </label>
        </div>
      </section>

      {picking && ws.kind === "local_path" && (
        <PathPicker
          initialPath={ws.path}
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            setLocal({ path });
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
