import {
  type Catalog,
  type FlowDefinition,
  type GitHubPullRequestTrigger,
  type InputDef,
  type LocalPathWorkspace,
  type ModelEntry,
  MODEL_ROLE_LABELS,
  PR_EVENTS,
  type PrEvent,
  pullRequestInputOf,
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
 * Replaces the flow's inputs and keeps the workspace consistent with them: a pull request input implies the PR
 * checkout workspace, auto approval and no open network; without one, a PR checkout falls back to a local workspace.
 */
function withInputs(def: FlowDefinition, inputs: InputDef[]): FlowDefinition {
  if (pullRequestInputOf({ inputs })) {
    const network = def.sandbox.network;
    return {
      ...def,
      inputs,
      workspace: { kind: "github_checkout" },
      approval: "auto",
      sandbox: network.mode === "open" ? { ...def.sandbox, network: { ...network, mode: "gateway_only" } } : def.sandbox,
    };
  }
  return { ...def, inputs, workspace: def.workspace.kind === "github_checkout" ? DEFAULT_LOCAL_WORKSPACE : def.workspace };
}

/** First of `pr`, `pr_2`, … not used as an input key. */
function freePrKey(inputs: InputDef[]): string {
  const keys = new Set(inputs.map((i) => i.key));
  if (!keys.has("pr")) return "pr";
  let n = 2;
  while (keys.has(`pr_${n}`)) n++;
  return `pr_${n}`;
}

/**
 * Switches the trigger kind. The pull request trigger fills the flow's PR input, so one is added when missing and
 * every other input becomes optional; returning to manual only changes the trigger.
 */
function withTrigger(def: FlowDefinition, kind: FlowDefinition["trigger"]["kind"]): FlowDefinition {
  if (kind === def.trigger.kind) return def;
  if (kind === "manual") return { ...def, trigger: { kind: "manual" } };
  const others = def.inputs.map((i): InputDef => (i.type === "github_pull_request" ? i : { ...i, required: false }));
  const inputs: InputDef[] = pullRequestInputOf(def)
    ? others
    : [...others, { key: freePrKey(def.inputs), label: "Pull request", type: "github_pull_request", required: true }];
  return withInputs(
    {
      ...def,
      trigger: {
        kind: "github_pull_request",
        repos: [],
        events: [...PR_EVENTS],
        forkPolicy: "require_approval",
        postChecks: true,
      },
    },
    inputs,
  );
}

/** Editor for flow-level settings: trigger, inputs, workspace, sandbox network, harness, approval, runner labels. */
export function InputsPanel({
  def,
  errors,
  catalog,
  onChange,
}: {
  def: FlowDefinition;
  errors: string[];
  catalog: Catalog | undefined;
  onChange: (def: FlowDefinition) => void;
}) {
  const [picking, setPicking] = useState(false);
  const ws = def.workspace;
  const net = def.sandbox.network;
  const trigger = def.trigger;
  const prInput = pullRequestInputOf(def);
  const setInputs = (inputs: InputDef[]) => onChange(withInputs(def, inputs));
  const setInput = (idx: number, patch: Partial<InputDef>) =>
    setInputs(
      def.inputs.map((i, n) => {
        if (n !== idx) return i;
        const next = { ...i, ...patch };
        return next.type === "github_pull_request" ? { ...next, required: true } : next;
      }),
    );
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
                checked={trigger.postChecks !== false}
                onChange={(e) => setPr({ postChecks: e.target.checked })}
              />
              Publish a check run on the pull request head
            </label>
          </>
        )}
      </section>

      <section>
        <h4>Inputs</h4>
        {def.inputs.length === 0 && (
          <p className="muted small">No inputs. Reference inputs as {"{{inputs.<key>}}"}.</p>
        )}
        {def.inputs.map((input, idx) => {
          const isPr = input.type === "github_pull_request";
          return (
            <div key={idx}>
              <div className="input-row">
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
                  <option value="github_pull_request" disabled={!!prInput && !isPr}>
                    github_pull_request
                  </option>
                </select>
                <label className="check" title={isPr ? "A pull request input is always required" : "Required"}>
                  <input
                    type="checkbox"
                    checked={isPr || input.required}
                    disabled={isPr}
                    onChange={(e) => setInput(idx, { required: e.target.checked })}
                  />
                  req
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove input"
                  onClick={() => setInputs(def.inputs.filter((_, n) => n !== idx))}
                >
                  ×
                </button>
              </div>
              {isPr && (
                <p className="muted small">
                  <span className="mono">title</span> and <span className="mono">body</span> arrive wrapped in{" "}
                  <span className="mono">&lt;untrusted_pr_text&gt;</span>; the diff is at{" "}
                  <span className="mono">{`{{inputs.${input.key}.diffPath}}`}</span>.
                </p>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="btn small"
          onClick={() =>
            setInputs([...def.inputs, { key: `input_${def.inputs.length + 1}`, label: "", type: "text", required: true }])
          }
        >
          + Add input
        </button>
      </section>

      <section>
        <h4>Workspace</h4>
        {ws.kind === "github_checkout" ? (
          <p className="muted small">
            The runner checks out the head of the pull request input on the host and mounts it read-only; the diff
            against the base is at <span className="mono">/orch/context/pr.diff</span>.
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
            <option value="open" disabled={!!prInput}>
              open (any http/https){prInput ? " — not allowed with a pull request input" : ""}
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
        <ModelSelect
          label="Model"
          value={def.harness.model}
          models={catalog?.models ?? []}
          onChange={(model) => onChange({ ...def, harness: { ...def.harness, model } })}
        />
        <ModelSelect
          label="Small model (optional)"
          value={def.harness.smolModel ?? ""}
          models={catalog?.models ?? []}
          onChange={(smolModel) =>
            onChange({ ...def, harness: { ...def.harness, smolModel: smolModel === "" ? undefined : smolModel } })
          }
        />
        <ModelRolesEditor
          roles={def.harness.modelRoles ?? {}}
          models={catalog?.models ?? []}
          onChange={(modelRoles) =>
            onChange({ ...def, harness: { ...def.harness, modelRoles: Object.keys(modelRoles).length ? modelRoles : undefined } })
          }
        />
        <div className="grid2">
          <label className="field">
            <span>Tool approval</span>
            <select
              value={def.approval}
              onChange={(e) => onChange({ ...def, approval: e.target.value as FlowDefinition["approval"] })}
            >
              <option value="auto">auto (no prompts)</option>
              <option value="ask" disabled={!!prInput}>
                ask (approve in run view){prInput ? " — not allowed with a pull request input" : ""}
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

/** Model ids grouped by provider for an `<optgroup>` select. */
function groupByProvider(models: ModelEntry[]): [string, ModelEntry[]][] {
  const groups = new Map<string, ModelEntry[]>();
  for (const m of models) {
    const i = m.id.indexOf("/");
    const provider = i > 0 ? m.id.slice(0, i) : "other";
    (groups.get(provider) ?? groups.set(provider, []).get(provider)!).push(m);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Label for a model option: display name plus the full id when it differs. */
function modelLabel(m: ModelEntry): string {
  return m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id;
}

/**
 * Model picker for one harness role. A select fed by the runners' gateway models (kept as an option even when
 * the model is no longer advertised); free text when no runner is online to advertise models.
 */
function ModelSelect({
  label,
  value,
  models,
  onChange,
}: {
  label: string;
  value: string;
  models: ModelEntry[];
  onChange: (model: string) => void;
}) {
  const known = models.some((m) => m.id === value);
  const set = (next: string) => onChange(next === FREE_ENTRY ? value : next);
  return (
    <label className="field">
      <span>{label}</span>
      {models.length > 0 ? (
        <>
          <select value={value === "" ? "" : known ? value : FREE_ENTRY} onChange={(e) => set(e.target.value)}>
            {value === "" && <option value="">—</option>}
            {!known && value !== "" && <option value={FREE_ENTRY}>{value}</option>}
            {groupByProvider(models).map(([provider, group]) => (
              <optgroup key={provider} label={provider}>
                {group.map((m) => (
                  <option key={m.id} value={m.id}>
                    {modelLabel(m)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {!known && value !== "" && (
            <input
              className="mono"
              aria-label={`${label} (custom model id)`}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </>
      ) : (
        <input className="mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder="provider/model" />
      )}
    </label>
  );
}

const FREE_ENTRY = "__custom__";
const CUSTOM_ROLE = "__custom_role__";

/** First known role not yet assigned, or `role_1` when all are taken. */
function nextFreeRole(roles: Record<string, string>): string {
  for (const role of Object.keys(MODEL_ROLE_LABELS)) if (!(role in roles)) return role;
  let n = 1;
  while (`role_${n}` in roles) n++;
  return `role_${n}`;
}

/** Edits the harness's extra model roles (e.g. slow, plan): known roles populate a select; other roles render the name as free text. */
function ModelRolesEditor({
  roles,
  models,
  onChange,
}: {
  roles: Record<string, string>;
  models: ModelEntry[];
  onChange: (roles: Record<string, string>) => void;
}) {
  const entries = Object.entries(roles);
  const setRole = (idx: number, role: string) =>
    onChange(Object.fromEntries(entries.map(([r, m], i) => (i === idx ? [role, m] : [r, m]))));
  const setModel = (idx: number, model: string) =>
    onChange(Object.fromEntries(entries.map(([r, m], i) => (i === idx ? [r, model] : [r, m]))));
  const remove = (idx: number) => onChange(Object.fromEntries(entries.filter((_, i) => i !== idx)));
  const taken = new Set(entries.map(([r]) => r));
  return (
    <div className="field">
      <span>Other model roles (unset roles use the main model)</span>
      {entries.map(([role, model], idx) => {
        const known = role in MODEL_ROLE_LABELS;
        return (
          <div key={idx} className="row gap model-role-row">
            <select
              className="role-name"
              aria-label="Model role"
              value={known ? role : CUSTOM_ROLE}
              onChange={(e) => setRole(idx, e.target.value === CUSTOM_ROLE ? role : e.target.value)}
            >
              {Object.entries(MODEL_ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value} disabled={value !== role && taken.has(value)}>
                  {label}
                </option>
              ))}
              <option value={CUSTOM_ROLE}>custom…{!known ? ` (${role})` : ""}</option>
            </select>
            {!known && (
              <input
                className="mono role-name-input"
                aria-label="Custom model role name"
                value={role}
                onChange={(e) => setRole(idx, e.target.value)}
              />
            )}
            <ModelSelect label="" value={model} models={models} onChange={(m) => setModel(idx, m)} />
            <button type="button" className="icon-btn" aria-label={`Remove ${role || "role"}`} onClick={() => remove(idx)}>
              ×
            </button>
          </div>
        );
      })}
      <div>
        <button
          type="button"
          className="btn small"
          onClick={() => onChange({ ...roles, [nextFreeRole(roles)]: models[0]?.id ?? "provider/model" })}
        >
          + Add model role
        </button>
      </div>
    </div>
  );
}
