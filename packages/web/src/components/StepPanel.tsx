import {
  type Catalog,
  type FlowDefinition,
  isAgentStep,
  type Step,
  type TemplateVariable,
  templateVariables,
} from "@orch/protocol";
import { useId, useRef } from "react";

export const KIND_LABEL: Record<Step["kind"], string> = {
  prompt: "Prompt",
  skill: "Skill",
  command: "Command",
  git_commit: "Git commit",
  git_push: "Git push",
  github_pr: "GitHub PR",
};

export const KIND_ICON: Record<Step["kind"], string> = {
  prompt: "✎",
  skill: "★",
  command: "/",
  git_commit: "●",
  git_push: "↑",
  github_pr: "⇄",
};

/** Clickable list of the variables a template field can reference, grouped into inputs and earlier steps. */
function TemplateVariables({ vars, onInsert }: { vars: TemplateVariable[]; onInsert: (path: string) => void }) {
  const groups: [string, TemplateVariable[], string][] = [
    ["Inputs", vars.filter((v) => v.path.startsWith("inputs.")), "No inputs declared."],
    ["Earlier steps", vars.filter((v) => v.path.startsWith("steps.")), "No earlier steps."],
  ];
  return (
    <div className="template-vars">
      <div className="small muted">Template variables · click to insert at the cursor</div>
      {groups.map(([title, items, empty]) => (
        <div key={title} className="template-vars-group">
          <div className="template-vars-title">{title}</div>
          {items.length === 0 && <div className="small muted">{empty}</div>}
          {items.map((v) => (
            <button key={v.path} type="button" className="template-var" onClick={() => onInsert(v.path)}>
              <code>{`{{${v.path}}}`}</code>
              <span className="muted small">{v.description}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Textarea for a templated field plus the list of variables available at this step. */
function TemplateField({
  label,
  rows,
  value,
  vars,
  onChange,
}: {
  label: string;
  rows: number;
  value: string;
  vars: TemplateVariable[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (path: string) => {
    const el = ref.current;
    const token = `{{${path}}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} ref={ref} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      <TemplateVariables vars={vars} onInsert={insert} />
    </div>
  );
}

/** Editor form for one step; `onChange` receives the whole replacement step. */
export function StepPanel({
  def,
  index,
  catalog,
  errors,
  onChange,
  onMove,
  onDelete,
}: {
  def: FlowDefinition;
  index: number;
  catalog: Catalog | undefined;
  errors: string[];
  onChange: (step: Step) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const step = def.steps[index]!;
  const earlierAgentSteps = def.steps.slice(0, index).filter(isAgentStep);
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch } as Step);

  const refSelect = (label: string, value: string, patchKey: "messageFrom" | "titleFrom" | "bodyFrom") => (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => set({ [patchKey]: e.target.value } as Partial<Step>)}>
        <option value="">— choose an earlier agent step —</option>
        {value && !earlierAgentSteps.some((s) => s.id === value) && <option value={value}>{value} (invalid)</option>}
        {earlierAgentSteps.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} ({s.id})
          </option>
        ))}
      </select>
    </label>
  );

  const catalogSelect = (kind: "skill" | "command", value: string) => {
    const items = kind === "skill" ? (catalog?.skills ?? []) : (catalog?.commands ?? []);
    const current = items.find((i) => i.name === value);
    return (
      <label className="field">
        <span>{kind === "skill" ? "Skill" : "Command"}</span>
        <select value={value} onChange={(e) => set({ [kind]: e.target.value } as Partial<Step>)}>
          <option value="">— choose —</option>
          {value && !current && <option value={value}>{value} (not offered by any online runner)</option>}
          {items.map((i) => (
            <option key={i.name} value={i.name}>
              {i.name}
            </option>
          ))}
        </select>
        {current?.description && <small className="muted">{current.description}</small>}
      </label>
    );
  };

  const vars = templateVariables(def, index);

  return (
    <div className="panel-body">
      <div className="panel-title">
        <span className="kind-icon">{KIND_ICON[step.kind]}</span>
        <div className="panel-title-text">
          <h3>{step.name || "(unnamed step)"}</h3>
          <div className="small muted">
            Step {index + 1} · {KIND_LABEL[step.kind]} · <span className="step-id">{step.id || "(no id)"}</span>
          </div>
        </div>
        <span className="grow" />
        <button type="button" className="btn small" disabled={index === 0} onClick={() => onMove(-1)} title="Move up">
          ↑
        </button>
        <button
          type="button"
          className="btn small"
          disabled={index === def.steps.length - 1}
          onClick={() => onMove(1)}
          title="Move down"
        >
          ↓
        </button>
        <button type="button" className="btn small danger" disabled={def.steps.length === 1} onClick={onDelete}>
          Delete
        </button>
      </div>
      {errors.length > 0 && (
        <ul className="error-list">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="grid2">
        <label className="field">
          <span>Id</span>
          <input className="mono" value={step.id} onChange={(e) => set({ id: e.target.value })} />
          <small className="muted">
            Later steps use <code>{`{{steps.${step.id || "<id>"}.output}}`}</code>
          </small>
        </label>
        <label className="field">
          <span>Name</span>
          <input value={step.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>Timeout (seconds)</span>
        <input
          type="number"
          min={1}
          value={step.timeoutSec}
          onChange={(e) => set({ timeoutSec: Number(e.target.value) })}
        />
      </label>

      {step.kind === "prompt" && (
        <TemplateField label="Prompt" rows={8} value={step.prompt} vars={vars} onChange={(prompt) => set({ prompt })} />
      )}
      {step.kind === "skill" && catalogSelect("skill", step.skill)}
      {step.kind === "command" && catalogSelect("command", step.command)}
      {(step.kind === "skill" || step.kind === "command") && (
        <TemplateField
          label="Arguments (optional)"
          rows={3}
          value={step.args ?? ""}
          vars={vars}
          onChange={(args) => set({ args: args === "" ? undefined : args })}
        />
      )}
      {isAgentStep(step) && (
        <label className="check">
          <input
            type="checkbox"
            checked={step.freshSession}
            onChange={(e) => set({ freshSession: e.target.checked })}
          />
          Start a fresh agent session for this step
        </label>
      )}

      {step.kind === "git_commit" && refSelect("Commit message from", step.messageFrom, "messageFrom")}
      {step.kind === "git_push" && (
        <p className="muted small">Pushes the run branch to the GitHub origin remote using server-held credentials.</p>
      )}
      {step.kind === "github_pr" && (
        <>
          {refSelect("Title from (first line)", step.titleFrom, "titleFrom")}
          {refSelect("Body from", step.bodyFrom, "bodyFrom")}
          <label className="field">
            <span>Base branch (empty = repository default)</span>
            <input
              value={step.base ?? ""}
              onChange={(e) => set({ base: e.target.value === "" ? undefined : e.target.value })}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={step.draft} onChange={(e) => set({ draft: e.target.checked })} />
            Open as draft
          </label>
        </>
      )}
    </div>
  );
}
