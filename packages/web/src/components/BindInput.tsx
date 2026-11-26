// "Set from" control beside a bindable flow or step field: keep the fixed value, bind a compatible input, or create
// an input from the field's current value. Bindings are applied server-side when a run is created (`materializeFlow`).
import {
  type BindableField,
  type FlowDefinition,
  flowBindableField,
  ID_RE,
  type InputDef,
  isGitHubInput,
  MODEL_ROLE_BINDING_PREFIX,
  pullRequestInputOf,
  stepBindableField,
  valueAtPath,
  type ValueInputType,
} from "@orch/protocol";

/** A flow field by dotted path, or a field of the step at index `step`. */
export type BindTarget = { path: string } | { step: number; field: string };

type Bindings = FlowDefinition["bindings"];

const NEW_INPUT = "__new_input__";

function fieldOf(def: FlowDefinition, target: BindTarget): BindableField | null {
  if ("path" in target) {
    const lookup = flowBindableField(def, target.path);
    return lookup.ok ? lookup.field : null;
  }
  const step = def.steps[target.step];
  if (!step) return null;
  const lookup = stepBindableField(step, target.field);
  return lookup.ok ? lookup.field : null;
}

function fieldValue(def: FlowDefinition, target: BindTarget): unknown {
  return "path" in target ? valueAtPath(def, target.path) : valueAtPath(def.steps[target.step], target.field);
}

function setKey(bindings: Bindings, field: string, key: string | undefined): Bindings {
  const next = { ...bindings };
  if (key === undefined) delete next[field];
  else next[field] = key;
  return Object.keys(next).length ? next : undefined;
}

/** `def` with `target` bound to input `key`, or unbound (fixed value) when `key` is undefined. */
export function withBinding(def: FlowDefinition, target: BindTarget, key: string | undefined): FlowDefinition {
  if ("path" in target) return { ...def, bindings: setKey(def.bindings, target.path, key) };
  return {
    ...def,
    steps: def.steps.map((s, i) => (i === target.step ? { ...s, bindings: setKey(s.bindings, target.field, key) } : s)),
  };
}

/** Points every binding of input `from` (flow and steps) at `to`, or removes them when `to` is undefined. */
function renameInputBindings(def: FlowDefinition, from: string, to: string | undefined): FlowDefinition {
  const remap = (bindings: Bindings): Bindings => {
    if (!bindings || !Object.values(bindings).includes(from)) return bindings;
    const next: Record<string, string> = {};
    for (const [field, key] of Object.entries(bindings)) {
      if (key !== from) next[field] = key;
      else if (to !== undefined) next[field] = to;
    }
    return Object.keys(next).length ? next : undefined;
  };
  return {
    ...def,
    bindings: remap(def.bindings),
    steps: def.steps.map((s) => {
      const bindings = remap(s.bindings);
      return bindings === s.bindings ? s : { ...s, bindings };
    }),
  };
}

/**
 * Bindings after input `idx` is renamed to `to`, or removed when `to` is undefined. They follow the input only when
 * no other input has its old key (the bindings may be that input's) or the new one (they would silently move to it).
 */
export function bindingsAfterInputChange(def: FlowDefinition, idx: number, to: string | undefined): FlowDefinition {
  const from = def.inputs[idx]!.key;
  if (from === to) return def;
  const shared = def.inputs.some((i, n) => n !== idx && (i.key === from || i.key === to));
  return shared ? def : renameInputBindings(def, from, to);
}

/**
 * Keeps `harness.modelRoles.<role>` bindings on their role when the roles editor renames one (same count, same
 * order) and drops bindings of removed roles.
 */
export function syncRoleBindings(
  def: FlowDefinition,
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
): FlowDefinition {
  if (!def.bindings) return def;
  const oldRoles = Object.keys(before ?? {});
  const newRoles = Object.keys(after ?? {});
  const bindings = { ...def.bindings };
  if (oldRoles.length === newRoles.length) {
    oldRoles.forEach((role, i) => {
      const from = `${MODEL_ROLE_BINDING_PREFIX}${role}`;
      const renamed = newRoles[i]!;
      if (role === renamed || bindings[from] === undefined) return;
      bindings[`${MODEL_ROLE_BINDING_PREFIX}${renamed}`] = bindings[from];
      delete bindings[from];
    });
  } else {
    for (const role of oldRoles) if (!newRoles.includes(role)) delete bindings[`${MODEL_ROLE_BINDING_PREFIX}${role}`];
  }
  return { ...def, bindings: Object.keys(bindings).length ? bindings : undefined };
}

const snake = (s: string) => s.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/[^a-z0-9_]/g, "_");

/** Input key derived from the field: `workspace.path` → `path`, a role → `<role>_model`, a step field → `<step>_<field>`. */
function keyBase(def: FlowDefinition, target: BindTarget): string {
  if ("path" in target) {
    if (target.path.startsWith(MODEL_ROLE_BINDING_PREFIX)) return `${target.path.slice(MODEL_ROLE_BINDING_PREFIX.length)}_model`;
    const parts = target.path.split(".");
    return snake((parts.length > 1 ? parts.slice(1) : parts).join("_"));
  }
  const id = def.steps[target.step]?.id ?? "";
  return `${ID_RE.test(id) ? id : "step"}_${snake(target.field)}`;
}

function freeKey(inputs: InputDef[], base: string): string {
  const keys = new Set(inputs.map((i) => i.key));
  const start = ID_RE.test(base) ? base : `input_${base}`;
  if (!keys.has(start)) return start;
  let n = 2;
  while (keys.has(`${start}_${n}`)) n++;
  return `${start}_${n}`;
}

/**
 * An optional input that sets `target`, defaulting to the field's current value: a select over the field's values
 * for enum fields (minus those a pull request flow forbids), else the first non-select type the field accepts.
 */
function newInputFor(def: FlowDefinition, target: BindTarget, field: BindableField): InputDef {
  const current = fieldValue(def, target);
  const step = "path" in target ? undefined : def.steps[target.step];
  const base = {
    key: freeKey(def.inputs, keyBase(def, target)),
    label: step ? `${step.name}: ${field.label}` : field.label,
    required: false,
  };
  if (field.options) {
    const forbidden = pullRequestInputOf(def) ? ["open", "ask"] : [];
    const options = field.options.filter((o) => !forbidden.includes(o)).map((value) => ({ value }));
    const fallback = typeof current === "string" && options.some((o) => o.value === current) ? current : undefined;
    return { ...base, type: "select", options, ...(fallback !== undefined ? { default: fallback } : {}) };
  }
  const type = field.types.find((t): t is Exclude<ValueInputType, "select"> => t !== "select") ?? "text";
  switch (type) {
    case "number":
      return { ...base, type, ...(typeof current === "number" ? { default: current } : {}) };
    case "boolean":
      return { ...base, type, ...(typeof current === "boolean" ? { default: current } : {}) };
    case "path":
      return { ...base, type, ...(typeof current === "string" && current.startsWith("/") ? { default: current } : {}) };
    default: {
      const text = Array.isArray(current) ? current.join(", ") : typeof current === "string" ? current : "";
      return { ...base, type, ...(text !== "" ? { default: text } : {}) };
    }
  }
}

/** "Set from" select for one bindable field; renders nothing when the field cannot be bound here. */
export function BindInput({
  def,
  target,
  onChange,
}: {
  def: FlowDefinition;
  target: BindTarget;
  onChange: (def: FlowDefinition) => void;
}) {
  const field = fieldOf(def, target);
  if (!field) return null;
  const key = "path" in target ? def.bindings?.[target.path] : def.steps[target.step]?.bindings?.[target.field];
  const compatible = def.inputs.filter((i) => !isGitHubInput(i) && field.types.includes(i.type));
  const pick = (value: string) => {
    if (value === NEW_INPUT) {
      const input = newInputFor(def, target, field);
      onChange(withBinding({ ...def, inputs: [...def.inputs, input] }, target, input.key));
    } else {
      onChange(withBinding(def, target, value === "" ? undefined : value));
    }
  };
  return (
    <div className="bind-input">
      <select className="bind-select" aria-label={`Set ${field.label} from`} value={key ?? ""} onChange={(e) => pick(e.target.value)}>
        <option value="">fixed value</option>
        {key !== undefined && !compatible.some((i) => i.key === key) && <option value={key}>input {key} (invalid)</option>}
        {compatible.map((i) => (
          <option key={i.key} value={i.key}>
            input {i.key}
            {i.label ? ` · ${i.label}` : ""}
          </option>
        ))}
        <option value={NEW_INPUT}>+ New input from this field</option>
      </select>
      {key !== undefined && (
        <small className="muted">
          Used when input <code>{key}</code> is empty.
        </small>
      )}
    </div>
  );
}
