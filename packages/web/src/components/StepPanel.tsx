import { type Catalog, type FlowDefinition, isAgentStep, type Step } from "@orch/protocol";

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

  const templateHint = (
    <small className="muted">
      Template variables: {"{{inputs.<key>}}"}, {"{{steps.<id>.output}}"}, {"{{steps.<id>.structured}}"}
    </small>
  );

  return (
    <div className="panel-body">
      <div className="panel-title">
        <span className="kind-icon">{KIND_ICON[step.kind]}</span>
        <h3>{KIND_LABEL[step.kind]} step</h3>
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
        <label className="field">
          <span>Prompt</span>
          <textarea rows={8} value={step.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          {templateHint}
        </label>
      )}
      {step.kind === "skill" && catalogSelect("skill", step.skill)}
      {step.kind === "command" && catalogSelect("command", step.command)}
      {(step.kind === "skill" || step.kind === "command") && (
        <label className="field">
          <span>Arguments (optional)</span>
          <textarea
            rows={3}
            value={step.args ?? ""}
            onChange={(e) => set({ args: e.target.value === "" ? undefined : e.target.value })}
          />
          {templateHint}
        </label>
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
