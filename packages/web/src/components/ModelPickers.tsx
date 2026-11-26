import { type HarnessModels, type ModelEntry, MODEL_ROLE_BINDING_PREFIX, MODEL_ROLE_LABELS } from "@orch/protocol";
import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";

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
 * the model is no longer advertised); free text when no runner is online to advertise models. `extra` renders
 * below the picker (e.g. a `BindInput`). With `emptyLabel` the empty choice stays offered after a model is picked,
 * so the value can be cleared again; otherwise it shows only while the value is empty.
 */
export function ModelSelect({
  label,
  value,
  models,
  extra,
  emptyLabel,
  onChange,
}: {
  label: string;
  value: string;
  models: ModelEntry[];
  extra?: ReactNode;
  emptyLabel?: string;
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
            {(value === "" || emptyLabel !== undefined) && <option value="">{emptyLabel ?? "—"}</option>}
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
      {extra}
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
  bind,
  onChange,
}: {
  roles: Record<string, string>;
  models: ModelEntry[];
  bind?: (path: string) => ReactNode;
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
            <ModelSelect
              label=""
              value={model}
              models={models}
              extra={bind?.(`${MODEL_ROLE_BINDING_PREFIX}${role}`)}
              onChange={(m) => setModel(idx, m)}
            />
            <button type="button" className="icon-btn" aria-label={`Remove ${role || "role"}`} onClick={() => remove(idx)}>
              <X size={14} aria-hidden />
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
          <Plus size={14} aria-hidden /> Add model role
        </button>
      </div>
    </div>
  );
}

/**
 * The three harness model pickers (main, small, other roles), as in the flow editor and a run's details. `bind`
 * renders a control under each picker for its field path (`harness.model`, `harness.modelRoles.<role>`, …).
 */
export function HarnessModelPickers({
  value,
  models,
  bind,
  onChange,
}: {
  value: HarnessModels;
  models: ModelEntry[];
  bind?: (path: string) => ReactNode;
  onChange: (models: HarnessModels) => void;
}) {
  return (
    <>
      <ModelSelect
        label="Model"
        value={value.model}
        models={models}
        extra={bind?.("harness.model")}
        onChange={(model) => onChange({ ...value, model })}
      />
      <ModelSelect
        label="Small model (optional)"
        value={value.smolModel ?? ""}
        models={models}
        extra={bind?.("harness.smolModel")}
        onChange={(smolModel) => onChange({ ...value, smolModel: smolModel === "" ? undefined : smolModel })}
      />
      <ModelRolesEditor
        roles={value.modelRoles ?? {}}
        models={models}
        bind={bind}
        onChange={(modelRoles) => onChange({ ...value, modelRoles: Object.keys(modelRoles).length ? modelRoles : undefined })}
      />
    </>
  );
}
