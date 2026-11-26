import {
  type Catalog,
  type FlowDefinition,
  flowBindings,
  type GitHubPullRequestTrigger,
  type InputDef,
  INPUT_TYPES,
  type InputType,
  isGitHubInput,
  type LocalPathWorkspace,
  type ModelEntry,
  NETWORK_PRESETS,
  PR_EVENTS,
  type PrEvent,
  pullRequestInputOf,
  type SelectOption,
  type ValueInputDef,
} from "@orch/protocol";
import { useEffect, useState } from "react";
import { Plus, Settings2, X } from "lucide-react";
import { BindInput, bindingsAfterInputChange, syncRoleBindings } from "./BindInput";
import { HarnessModelPickers, ModelSelect } from "./ModelPickers";
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
 * checkout workspace (which has no fields to bind), auto approval and no open network; without one, a PR checkout
 * falls back to a local workspace.
 */
function withInputs(def: FlowDefinition, inputs: InputDef[]): FlowDefinition {
  if (pullRequestInputOf({ inputs })) {
    const network = def.sandbox.network;
    const bindings = Object.fromEntries(Object.entries(def.bindings ?? {}).filter(([path]) => !path.startsWith("workspace.")));
    return {
      ...def,
      inputs,
      workspace: { kind: "github_checkout" },
      approval: "auto",
      sandbox: network.mode === "open" ? { ...def.sandbox, network: { ...network, mode: "gateway_only" } } : def.sandbox,
      bindings: Object.keys(bindings).length ? bindings : undefined,
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
  const setInputs = (inputs: InputDef[], base: FlowDefinition = def) => onChange(withInputs(base, inputs));
  /** Replaces input `idx`; its bindings follow a key rename unless another input shares the old or new key. */
  const setInput = (idx: number, next: InputDef) => {
    const input = next.type === "github_pull_request" ? { ...next, required: true } : next;
    setInputs(
      def.inputs.map((i, n) => (n === idx ? input : i)),
      bindingsAfterInputChange(def, idx, next.key),
    );
  };
  /** A type change drops the old type's own fields (`default`, `options`). */
  const setInputType = (idx: number, type: InputType) => {
    const { key, label, required } = def.inputs[idx]!;
    setInput(idx, type === "select" ? { key, label, required, type, options: [] } : { key, label, required, type });
  };
  const removeInput = (idx: number) =>
    setInputs(
      def.inputs.filter((_, n) => n !== idx),
      bindingsAfterInputChange(def, idx, undefined),
    );
  /** First of `input_1`, `input_2`, … not used as a key: the row count may repeat a key after a removal. */
  const newInputKey = () => {
    const keys = new Set(def.inputs.map((i) => i.key));
    let n = 1;
    while (keys.has(`input_${n}`)) n++;
    return `input_${n}`;
  };
  const bindings = flowBindings(def);
  const bind = (path: string) => <BindInput def={def} target={{ path }} onChange={onChange} />;
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
        <span className="kind-icon">
          <Settings2 size={15} aria-hidden />
        </span>
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
                  onChange={(e) => setInput(idx, { ...input, key: e.target.value })}
                />
                <input placeholder="label" value={input.label} onChange={(e) => setInput(idx, { ...input, label: e.target.value })} />
                <select value={input.type} onChange={(e) => setInputType(idx, e.target.value as InputType)}>
                  {INPUT_TYPES.map((t) => (
                    <option key={t} value={t} disabled={t === "github_pull_request" && !!prInput && !isPr}>
                      {t}
                    </option>
                  ))}
                </select>
                <label className="check" title={isPr ? "A pull request input is always required" : "Required"}>
                  <input
                    type="checkbox"
                    checked={isPr || input.required}
                    disabled={isPr}
                    onChange={(e) => setInput(idx, { ...input, required: e.target.checked })}
                  />
                  req
                </label>
                <button type="button" className="icon-btn" aria-label="Remove input" onClick={() => removeInput(idx)}>
                  <X size={14} aria-hidden />
                </button>
              </div>
              {!isGitHubInput(input) && (
                <div className="input-details">
                  <InputDefaultEditor input={input} models={catalog?.models ?? []} onChange={(next) => setInput(idx, next)} />
                  {bindings.some((b) => b.key === input.key) && (
                    <p className="muted small">
                      Sets{" "}
                      {bindings
                        .filter((b) => b.key === input.key)
                        .map((b) => b.path)
                        .join(", ")}
                    </p>
                  )}
                </div>
              )}
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
            setInputs([...def.inputs, { key: newInputKey(), label: "", type: "text", required: true }])
          }
        >
          <Plus size={14} aria-hidden /> Add input
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
              {bind("workspace.path")}
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
                {bind("workspace.isolation")}
              </label>
              <label className="field">
                <span>Base ref</span>
                <input className="mono" value={ws.baseRef} onChange={(e) => setLocal({ baseRef: e.target.value })} />
                {bind("workspace.baseRef")}
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
                {bind("workspace.access")}
              </label>
            </div>
          </>
        )}
      </section>

      <section>
        <h4>Sandbox</h4>
        <label className="field">
          <span>Image</span>
          <input
            className="mono"
            value={def.sandbox.image}
            onChange={(e) => onChange({ ...def, sandbox: { ...def.sandbox, image: e.target.value } })}
          />
          {bind("sandbox.image")}
        </label>
        <div className="grid2">
          <label className="field">
            <span>CPUs</span>
            <input
              type="number"
              min={0}
              step="any"
              value={def.sandbox.cpus}
              onChange={(e) => onChange({ ...def, sandbox: { ...def.sandbox, cpus: Number(e.target.value) } })}
            />
            {bind("sandbox.cpus")}
          </label>
          <label className="field">
            <span>Memory (MB)</span>
            <input
              type="number"
              min={0}
              value={def.sandbox.memoryMb}
              onChange={(e) => onChange({ ...def, sandbox: { ...def.sandbox, memoryMb: Number(e.target.value) } })}
            />
            {bind("sandbox.memoryMb")}
          </label>
        </div>
        <label className="field">
          <span>Network</span>
          <select value={net.mode} onChange={(e) => setNetwork({ mode: e.target.value as typeof net.mode })}>
            <option value="gateway_only">gateway only (model calls)</option>
            <option value="allowlist">allowlist</option>
            <option value="open" disabled={!!prInput}>
              open (any http/https){prInput ? " — not allowed with a pull request input" : ""}
            </option>
          </select>
          {bind("sandbox.network.mode")}
        </label>
        {/* A bound mode may become allowlist at run time, so its domains stay editable. */}
        {(net.mode === "allowlist" || def.bindings?.["sandbox.network.mode"] !== undefined) && (
          <>
            <label className="field">
              <span>Allowed domains (one per line; leading “.” includes subdomains)</span>
              <ListField multiline value={net.allow} onChange={(allow) => setNetwork({ allow })} />
              {bind("sandbox.network.allow")}
            </label>
            <div className="field">
              <span>Add registry domains{prInput ? " — PR build scripts get the same access" : ""}</span>
              <div className="row gap">
                {Object.entries(NETWORK_PRESETS).map(([key, preset]) => (
                  <button
                    key={key}
                    type="button"
                    className="btn small"
                    title={preset.domains.join(", ")}
                    onClick={() => setNetwork({ allow: [...new Set([...net.allow, ...preset.domains])] })}
                  >
                    + {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      <section>
        <h4>Harness</h4>
        <HarnessModelPickers
          value={def.harness}
          models={catalog?.models ?? []}
          bind={bind}
          onChange={(models) =>
            onChange(syncRoleBindings({ ...def, harness: { ...def.harness, ...models } }, def.harness.modelRoles, models.modelRoles))
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
            {bind("approval")}
          </label>
          <label className="field">
            <span>Runner labels (comma separated)</span>
            <ListField value={def.runnerLabels} onChange={(runnerLabels) => onChange({ ...def, runnerLabels })} />
            {bind("runnerLabels")}
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

/** Per-type settings of a value input: its default (used when a run leaves it empty) and a select's options. */
function InputDefaultEditor({
  input,
  models,
  onChange,
}: {
  input: ValueInputDef;
  models: ModelEntry[];
  onChange: (input: InputDef) => void;
}) {
  const [picking, setPicking] = useState(false);
  const label = "Default (used when left empty)";
  switch (input.type) {
    case "text":
      return (
        <label className="field">
          <span>{label}</span>
          <input value={input.default ?? ""} onChange={(e) => onChange({ ...input, default: e.target.value || undefined })} />
        </label>
      );
    case "model":
      return (
        <ModelSelect
          label={label}
          value={input.default ?? ""}
          models={models}
          extra={
            input.default ? (
              <div>
                <button type="button" className="btn small" onClick={() => onChange({ ...input, default: undefined })}>
                  Clear default
                </button>
              </div>
            ) : undefined
          }
          onChange={(model) => onChange({ ...input, default: model || undefined })}
        />
      );
    case "path":
      return (
        <>
          <label className="field">
            <span>{label}</span>
            <div className="row gap">
              <input
                className="mono grow"
                placeholder="/absolute/path"
                value={input.default ?? ""}
                onChange={(e) => onChange({ ...input, default: e.target.value || undefined })}
              />
              <button type="button" className="btn small" onClick={() => setPicking(true)}>
                Browse…
              </button>
            </div>
          </label>
          {/* Outside the label: clicks in the dialog must not reach the label's input. */}
          {picking && (
            <PathPicker
              initialPath={input.default ?? ""}
              onClose={() => setPicking(false)}
              onSelect={(path) => {
                onChange({ ...input, default: path });
                setPicking(false);
              }}
            />
          )}
        </>
      );
    case "number":
      return (
        <label className="field">
          <span>{label}</span>
          <input
            type="number"
            step="any"
            value={input.default ?? ""}
            onChange={(e) => onChange({ ...input, default: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </label>
      );
    case "boolean":
      return (
        <label className="field">
          <span>{label}</span>
          <select
            value={input.default === undefined ? "" : String(input.default)}
            onChange={(e) => onChange({ ...input, default: e.target.value === "" ? undefined : e.target.value === "true" })}
          >
            <option value="">— none (unchecked) —</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </label>
      );
    case "select": {
      // Renaming or removing the default option carries the default along.
      const setOptions = (options: SelectOption[], fallback = input.default) => onChange({ ...input, options, default: fallback });
      return (
        <>
          <div className="field">
            <span>Options (value, optional label)</span>
            {input.options.map((o, i) => (
              <div key={i} className="row gap option-row">
                <input
                  className="mono grow"
                  placeholder="value"
                  aria-label="Option value"
                  value={o.value}
                  onChange={(e) =>
                    setOptions(
                      input.options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                      input.default === o.value ? e.target.value : input.default,
                    )
                  }
                />
                <input
                  className="grow"
                  placeholder="label (optional)"
                  aria-label="Option label"
                  value={o.label ?? ""}
                  onChange={(e) =>
                    setOptions(input.options.map((x, j) => (j === i ? { ...x, label: e.target.value || undefined } : x)))
                  }
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove option ${o.value}`}
                  onClick={() =>
                    setOptions(
                      input.options.filter((_, j) => j !== i),
                      input.default === o.value ? undefined : input.default,
                    )
                  }
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn small"
                onClick={() => setOptions([...input.options, { value: `option_${input.options.length + 1}` }])}
              >
                <Plus size={14} aria-hidden /> Add option
              </button>
            </div>
          </div>
          <label className="field">
            <span>{label}</span>
            <select
              value={input.default ?? ""}
              onChange={(e) => onChange({ ...input, default: e.target.value || undefined })}
            >
              <option value="">— none —</option>
              {input.options.map((o, i) => (
                <option key={i} value={o.value}>
                  {o.label || o.value}
                </option>
              ))}
            </select>
          </label>
        </>
      );
    }
  }
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
