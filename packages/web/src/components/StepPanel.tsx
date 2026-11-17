import {
  type Catalog,
  type FlowDefinition,
  isAgentStep,
  isTextStep,
  LOOP_MAX_ITERATIONS,
  type LoopStep,
  loopRanges,
  pullRequestInputOf,
  type Step,
  type TemplateVariable,
  templateVariables,
} from "@orch/protocol";
import { useId, useRef } from "react";

export const KIND_LABEL: Record<Step["kind"], string> = {
  prompt: "Prompt",
  skill: "Skill",
  command: "Command",
  slash: "Slash command",
  shell: "Shell command",
  git_commit: "Git commit",
  git_push: "Git push",
  github_pr: "GitHub PR",
  intervention: "Intervention",
  github_comment: "GitHub comment",
  loop: "Repeat from…",
};

export const KIND_ICON: Record<Step["kind"], string> = {
  prompt: "✉️",
  skill: "🧠",
  command: "⌨️",
  slash: "💬",
  shell: "🖥️",
  git_commit: "✅",
  git_push: "⏫",
  github_pr: "🚀",
  intervention: "⏸",
  github_comment: "📝",
  loop: "↺",
};

/** Subtitle for a loop stop condition, shared by the step panel and the canvas node. */
export function loopStopSubtitle(stop: Extract<Step, { kind: "loop" }>["stop"], maxIterations: number): string {
  switch (stop.when) {
    case "max":
      return `${maxIterations}× · fixed count`;
    case "value":
      return `up to ${maxIterations}× · until ${stop.is === "falsy" ? `not ${stop.ref}` : stop.ref}`;
    case "ask":
      return `up to ${maxIterations}× · ask each time`;
  }
}

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

/**
 * Choices for a loop's `value` stop, mirroring validateFlow: `.output` of text steps and declared
 * `.structured.<field>` of agent steps directly in body `[start, end)` (not inside a nested loop).
 */
function loopStopRefs(def: FlowDefinition, ranges: Map<number, number>, start: number, end: number): { value: string; label: string }[] {
  const choices: { value: string; label: string }[] = [];
  for (let i = start; i < end; i++) {
    const s = def.steps[i]!;
    if ([...ranges].some(([e, st]) => e < end && st >= start && st <= i && i < e)) continue;
    if (isTextStep(s)) choices.push({ value: `${s.id}.output`, label: `${s.name} (${s.id}.output)` });
    if (isAgentStep(s) && s.structured) {
      for (const f of s.structured.fields) {
        choices.push({ value: `${s.id}.structured.${f.name}`, label: `${s.name} (${s.id}.structured.${f.name})` });
      }
    }
  }
  return choices;
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
  const earlierSteps = def.steps.slice(0, index);
  const earlierAgentSteps = earlierSteps.filter(isAgentStep);
  const githubInputs = def.inputs.filter((i) => i.type !== "text");
  const set = (patch: Partial<Step>) => onChange({ ...step, ...patch } as Step);

  /** Select of an earlier step whose output feeds `patchKey`; agent steps unless `sources` says otherwise.
   * Agent steps with a structured spec also offer `<id>.structured.<field>` entries. */
  const refSelect = (
    label: string,
    value: string,
    patchKey: "messageFrom" | "titleFrom" | "bodyFrom",
    sources: { steps: Step[]; noun: string } = { steps: earlierAgentSteps, noun: "agent step" },
  ) => {
    const options: { value: string; label: string }[] = [];
    for (const s of sources.steps) {
      options.push({ value: s.id, label: `${s.name} (${s.id})` });
      if (isAgentStep(s) && s.structured) {
        for (const f of s.structured.fields) {
          options.push({ value: `${s.id}.structured.${f.name}`, label: `${s.name} (${s.id}.structured.${f.name})` });
        }
      }
    }
    return (
      <label className="field">
        <span>{label}</span>
        <select value={value} onChange={(e) => set({ [patchKey]: e.target.value } as Partial<Step>)}>
          <option value="">— choose an earlier {sources.noun} —</option>
          {value && !options.some((o) => o.value === value) && <option value={value}>{value} (invalid)</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  };

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
          {step.kind !== "loop" && (
            <small className="muted">
              Later steps use <code>{`{{steps.${step.id || "<id>"}.output}}`}</code>
            </small>
          )}
        </label>
        <label className="field">
          <span>Name</span>
          <input value={step.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
      </div>
      {step.kind !== "loop" && (
        <label className="field">
          <span>Timeout (seconds)</span>
          <input
            type="number"
            min={0}
            value={step.timeoutSec}
            onChange={(e) =>
              set(
                step.kind === "intervention" && e.target.value === ""
                  ? { timeoutSec: undefined }
                  : { timeoutSec: Number(e.target.value) },
              )
            }
          />
          {step.timeoutSec === 0 && (
            <small className="muted">0 = no timeout (runs until the step finishes or the run is cancelled)</small>
          )}
          {step.kind === "intervention" && step.timeoutSec === undefined && (
            <small className="muted">Empty = wait forever (until answered or the run is cancelled)</small>
          )}
        </label>
      )}

      {step.kind === "intervention" && (
        <>
          <TemplateField
            label="Reviewer note (optional)"
            rows={4}
            value={step.message ?? ""}
            vars={vars}
            onChange={(message) => set({ message: message === "" ? undefined : message })}
          />
          <p className="muted small">
            The run pauses here and opens a chat in the run view: message the agent session or an earlier slash step's session
            (slash commands work too) as often as needed, then continue. The selected session's latest reply becomes{" "}
            <code>{`{{steps.${step.id}.output}}`}</code>.
          </p>
        </>
      )}

      {step.kind === "loop" && <LoopFields step={step} def={def} index={index} vars={vars} set={set} />}

      {step.kind === "prompt" && (
        <TemplateField label="Prompt" rows={8} value={step.prompt} vars={vars} onChange={(prompt) => set({ prompt })} />
      )}
      {step.kind === "skill" && catalogSelect("skill", step.skill)}
      {step.kind === "command" && catalogSelect("command", step.command)}
      {step.kind === "slash" && (
        <label className="field">
          <span>Command</span>
          <input
            className="mono"
            placeholder="review"
            value={step.command}
            onChange={(e) => set({ command: e.target.value })}
          />
          <small className="muted">
            Runs <code>{`omp -p /${step.command || "<command>"}`}</code> headless in the sandbox — e.g. <code>review</code>,{" "}
            <code>plan</code>, <code>init</code>.
          </small>
        </label>
      )}
      {step.kind === "slash" && (
        <TemplateField
          label="Arguments (optional)"
          rows={3}
          value={step.args ?? ""}
          vars={vars}
          onChange={(args) => set({ args: args === "" ? undefined : args })}
        />
      )}
      {(step.kind === "skill" || step.kind === "command") && (
        <TemplateField
          label="Arguments (optional)"
          rows={3}
          value={step.args ?? ""}
          vars={vars}
          onChange={(args) => set({ args: args === "" ? undefined : args })}
        />
      )}
      {step.kind === "shell" && (
        <>
          <TemplateField
            label="Command"
            rows={6}
            value={step.command}
            vars={vars}
            onChange={(command) => set({ command })}
          />
          <p className="muted small">
            Runs as <code>bash -c</code> in the sandbox at the workspace path. Stdout becomes{" "}
            <code>{`{{steps.${step.id}.output}}`}</code>; stderr streams to the run log. A non-zero exit fails
            the step.
          </p>
          {pullRequestInputOf(def) && (
            <p className="warn-box">
              ⚠️ This flow runs on untrusted pull requests. The command runs in the PR author's checkout, so
              anything it executes there (build scripts, tests, package installs, repo binaries) is code they
              control, with the sandbox's network and gateway access. Template values reach bash as data, but
              never <code>eval</code> them or pass them to tools that interpret them as code.
            </p>
          )}
        </>
      )}
      {isAgentStep(step) && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={step.freshSession}
              onChange={(e) => set({ freshSession: e.target.checked })}
            />
            Start a fresh agent session for this step
          </label>
          <div className="field">
            <span>Structured output (optional)</span>
            <small className="muted">
              The agent must call <code>submit_output</code> with a JSON object containing at least these fields before finishing; later steps read{" "}
              <code>{`{{steps.${step.id || "<id>"}.structured.<field>}}`}</code>.
            </small>
            {(step.structured?.fields ?? []).map((f, i) => (
              <div className="grid2" key={i}>
                <input
                  className="mono"
                  placeholder="field_name"
                  value={f.name}
                  onChange={(e) => {
                    const fields = [...(step.structured?.fields ?? [])];
                    fields[i] = { ...f, name: e.target.value };
                    set({ structured: { fields } } as Partial<Step>);
                  }}
                />
                <input
                  placeholder="Description for the model"
                  value={f.description}
                  onChange={(e) => {
                    const fields = [...(step.structured?.fields ?? [])];
                    fields[i] = { ...f, description: e.target.value };
                    set({ structured: { fields } } as Partial<Step>);
                  }}
                />
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => {
                    const fields = (step.structured?.fields ?? []).filter((_, j) => j !== i);
                    set({ structured: fields.length ? { fields } : undefined } as Partial<Step>);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn small"
              onClick={() => set({ structured: { fields: [...(step.structured?.fields ?? []), { name: "", description: "" }] } } as Partial<Step>)}
            >
              + Add field
            </button>
          </div>
        </>
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
      {step.kind === "github_comment" && (
        <>
          <label className="field">
            <span>Comment on</span>
            <select value={step.target} onChange={(e) => set({ target: e.target.value })}>
              {(!step.target || githubInputs.length === 0) && <option value="">— choose an issue or pull request input —</option>}
              {step.target && !githubInputs.some((i) => i.key === step.target) && (
                <option value={step.target}>{step.target} (invalid)</option>
              )}
              {githubInputs.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.label || i.key} ({i.key})
                </option>
              ))}
            </select>
            {githubInputs.length === 0 && (
              <small className="muted">Add a github_issue or github_pull_request input</small>
            )}
          </label>
          {refSelect("Comment body from", step.bodyFrom, "bodyFrom", {
            steps: earlierSteps.filter(isTextStep),
            noun: "prompt, skill, command, slash, shell or intervention step",
          })}
          <p className="muted small">Posts the body as a comment (mentions neutralized); the step output is the comment URL.</p>
        </>
      )}
    </div>
  );
}

/** Form fields for a `loop` step. */
function LoopFields({
  step,
  def,
  index,
  vars,
  set,
}: {
  step: LoopStep;
  def: FlowDefinition;
  index: number;
  vars: TemplateVariable[];
  set: (patch: Partial<LoopStep>) => void;
}) {
  const group = useId();
  const ranges = loopRanges(def);
  // `to` candidates mirror validateFlow: earlier non-loop steps whose body `[to, index]` nests with or is
  // disjoint from every other loop body.
  const toOptions = def.steps.slice(0, index).flatMap((s, t) => {
    if (s.kind === "loop") return [];
    const crosses = [...ranges].some(([end, start]) => {
      if (end === index) return false;
      const overlap = t <= end && start <= index;
      const nested = (t <= start && end <= index) || (start <= t && index <= end);
      return overlap && !nested;
    });
    return crosses ? [] : [{ value: s.id, label: `${s.name} (${s.id})` }];
  });
  const start = ranges.get(index);
  const refChoices = start === undefined ? [] : loopStopRefs(def, ranges, start, index);
  const stop = step.stop;

  return (
    <>
      <label className="field">
        <span>Repeat from</span>
        <select value={step.to} onChange={(e) => set({ to: e.target.value })}>
          <option value="">— choose an earlier step —</option>
          {step.to && !toOptions.some((o) => o.value === step.to) && <option value={step.to}>{step.to} (invalid)</option>}
          {toOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <small className="muted">The loop body runs from this step up to this loop step, then jumps back.</small>
      </label>

      <label className="field">
        <span>Max iterations</span>
        <input
          type="number"
          min={1}
          max={LOOP_MAX_ITERATIONS}
          value={step.maxIterations}
          onChange={(e) => set({ maxIterations: Number(e.target.value) })}
        />
        <small className="muted">1–{LOOP_MAX_ITERATIONS}: the body runs at most this many times.</small>
      </label>

      <div className="field">
        <span>Stop</span>
        <label className="check">
          <input type="radio" name={`${group}-stop`} checked={stop.when === "max"} onChange={() => set({ stop: { when: "max" } })} />
          after max iterations (fixed count)
        </label>
        <label className="check">
          <input
            type="radio"
            name={`${group}-stop`}
            checked={stop.when === "value"}
            onChange={() => set({ stop: { when: "value", ref: refChoices[0]?.value ?? "", is: "truthy" } })}
          />
          when a value is…
        </label>
        <label className="check">
          <input type="radio" name={`${group}-stop`} checked={stop.when === "ask"} onChange={() => set({ stop: { when: "ask" } })} />
          ask me each time
        </label>
      </div>

      {stop.when === "value" && (
        <>
          <div className="grid2">
            <label className="field">
              <span>Value</span>
              <select value={stop.ref} onChange={(e) => set({ stop: { ...stop, ref: e.target.value } })}>
                <option value="">— choose a value in the loop body —</option>
                {stop.ref && !refChoices.some((c) => c.value === stop.ref) && <option value={stop.ref}>{stop.ref} (invalid)</option>}
                {refChoices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>is</span>
              <select value={stop.is} onChange={(e) => set({ stop: { ...stop, is: e.target.value === "falsy" ? "falsy" : "truthy" } })}>
                <option value="truthy">truthy</option>
                <option value="falsy">falsy</option>
              </select>
            </label>
          </div>
          <p className="muted small">
            Checked right after that step succeeds, so the loop can stop mid-body (the rest of the body is skipped). Falsy:
            empty text, <code>false</code>, <code>no</code>, <code>0</code>, <code>null</code>, <code>[]</code>, <code>{"{}"}</code>;
            anything else is truthy. To stop on a review verdict, declare a structured field such as <code>approved</code> ("true
            when the change needs no more fixes") on the review step; it shows up here as <code>{"<id>.structured.approved"}</code>.
          </p>
        </>
      )}

      {stop.when === "ask" && (
        <>
          <TemplateField
            label="Question (optional)"
            rows={3}
            value={stop.message ?? ""}
            vars={vars}
            onChange={(message) => set({ stop: { when: "ask", ...(message === "" ? {} : { message }) } })}
          />
          <label className="field">
            <span>Answer timeout (seconds, optional)</span>
            <input
              type="number"
              min={0}
              value={step.timeoutSec ?? ""}
              onChange={(e) => set({ timeoutSec: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
            <small className="muted">Caps each wait for an answer; empty = wait forever.</small>
          </label>
          <p className="muted small">
            The run pauses here like an intervention: chat with the run's sessions, then repeat from the start of the body or
            continue.
          </p>
        </>
      )}

      {stop.when === "value" && (
        <label className="field">
          <span>When max iterations are reached</span>
          <select value={step.onExhausted} onChange={(e) => set({ onExhausted: e.target.value === "fail" ? "fail" : "continue" })}>
            <option value="continue">continue with the next step</option>
            <option value="fail">fail the run</option>
          </select>
        </label>
      )}
    </>
  );
}
