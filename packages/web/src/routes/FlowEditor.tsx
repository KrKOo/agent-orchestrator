import {
  type FlowDefinition,
  type FlowRow,
  isAgentStep,
  isTextStep,
  pullRequestInputOf,
  type Step,
  STEP_KINDS,
  type StepKind,
  validateFlow,
} from "@orch/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  EdgeLabelRenderer,
  getStraightPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ApiRequestError, api, errorMessage } from "../api";
import { DEFAULT_LOCAL_WORKSPACE, InputsPanel } from "../components/InputsPanel";
import { KIND_ICON, KIND_LABEL, StepPanel } from "../components/StepPanel";
import { Modal } from "../ui";

const NEW_FLOW: FlowDefinition = {
  name: "New flow",
  inputs: [],
  workspace: DEFAULT_LOCAL_WORKSPACE,
  sandbox: {
    provider: "docker",
    image: "orch/sandbox-omp:latest",
    network: { mode: "gateway_only", allow: [] },
    cpus: 2,
    memoryMb: 4096,
  },
  harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
  approval: "auto",
  runnerLabels: [],
  trigger: { kind: "manual" },
  steps: [{ id: "prompt_1", kind: "prompt", name: "Prompt", prompt: "", freshSession: false, timeoutSec: 1800 }],
};

function newStep(kind: StepKind, id: string, earlier: Step[], inputs: FlowDefinition["inputs"]): Step {
  const base = { id, name: KIND_LABEL[kind], timeoutSec: 1800 };
  const lastAgent = earlier.filter(isAgentStep).at(-1)?.id ?? "";
  switch (kind) {
    case "prompt":
      return { ...base, kind, prompt: "", freshSession: false };
    case "skill":
      return { ...base, kind, skill: "", freshSession: false };
    case "command":
      return { ...base, kind, command: "", freshSession: false };
    case "slash":
      return { ...base, kind, command: "" };
    case "git_commit":
      return { ...base, kind, messageFrom: lastAgent };
    case "git_push":
      return { ...base, kind };
    case "github_pr":
      return { ...base, kind, titleFrom: lastAgent, bodyFrom: lastAgent, draft: false };
    case "intervention":
      return { id, name: KIND_LABEL[kind], kind, message: "" };
    case "github_comment": {
      const target = pullRequestInputOf({ inputs }) ?? inputs.find((i) => i.required && i.type !== "text");
      return { ...base, kind, target: target?.key ?? "", bodyFrom: earlier.filter(isTextStep).at(-1)?.id ?? "" };
    }
  }
}

/** Fills missing top-level sections from defaults so raw JSON edits stay renderable; validation reports the rest. */
function normalizeDraft(raw: unknown): FlowDefinition | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Flow JSON must be an object";
  const r = raw as Partial<FlowDefinition>;
  if (!Array.isArray(r.steps) || r.steps.some((s) => !s || typeof s !== "object" || !STEP_KINDS.includes(s.kind))) {
    return `"steps" must be an array of steps with kind ${STEP_KINDS.join(" | ")}`;
  }
  return {
    ...NEW_FLOW,
    ...r,
    inputs: Array.isArray(r.inputs) ? r.inputs : [],
    runnerLabels: Array.isArray(r.runnerLabels) ? r.runnerLabels : [],
    workspace: r.workspace?.kind === "github_checkout" ? r.workspace : { ...DEFAULT_LOCAL_WORKSPACE, ...r.workspace },
    harness: { ...NEW_FLOW.harness, ...r.harness },
    sandbox: {
      ...NEW_FLOW.sandbox,
      ...r.sandbox,
      network: { ...NEW_FLOW.sandbox.network, ...r.sandbox?.network },
    },
  } as FlowDefinition;
}

type Selection = "inputs" | number;

interface ChainNodeData extends Record<string, unknown> {
  icon: string;
  title: string;
  /** Step id shown as a badge; absent on the settings node. */
  stepId?: string;
  subtitle: string;
  errors: string[];
  selected: boolean;
}
type ChainNode = Node<ChainNodeData, "chain">;

interface InsertEdgeData extends Record<string, unknown> {
  onInsert: () => void;
}
type InsertEdge = Edge<InsertEdgeData, "insert">;

function ChainNodeView({ data }: NodeProps<ChainNode>) {
  return (
    <div className={`chain-node ${data.selected ? "selected" : ""} ${data.errors.length ? "invalid" : ""}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="kind-icon">{data.icon}</span>
      <div className="chain-node-text">
        <div className="chain-node-head">
          <span className="chain-node-title">{data.title}</span>
          {data.stepId !== undefined && (
            <span className="step-id" title="Step id">
              {data.stepId || "(no id)"}
            </span>
          )}
        </div>
        <div className="chain-node-sub">{data.subtitle}</div>
      </div>
      {data.errors.length > 0 && (
        <span className="badge-error" title={data.errors.join("\n")}>
          {data.errors.length}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

function EndNodeView() {
  return (
    <div className="end-node">
      <Handle type="target" position={Position.Top} isConnectable={false} />
      end
    </div>
  );
}

function InsertEdgeView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<InsertEdge>) {
  const [path, labelX, labelY] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return (
    <>
      <BaseEdge id={id} path={path} />
      <EdgeLabelRenderer>
        <button
          type="button"
          className="insert-btn nodrag nopan"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={data?.onInsert}
          title="Insert step here"
        >
          +
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { chain: ChainNodeView, end: EndNodeView };
const edgeTypes = { insert: InsertEdgeView };

const NODE_WIDTH = 300;
const ROW = 110;

/** Subtitle of the "Trigger, Inputs & Workspace" node. */
function settingsSubtitle(def: FlowDefinition): string {
  if (def.trigger.kind === "github_pull_request") {
    return `on PRs · ${def.trigger.repos.join(", ") || "(no repositories)"}`;
  }
  if (pullRequestInputOf(def)) return "manual · pull request checkout";
  return def.workspace.kind === "local_path" ? def.workspace.path || "(choose a workspace path)" : "manual";
}

function stepSubtitle(step: Step): string {
  switch (step.kind) {
    case "prompt":
      return step.prompt.split("\n")[0] || "(empty prompt)";
    case "skill":
      return step.skill || "(no skill chosen)";
    case "command":
      return step.command ? `/${step.command}` : "(no command chosen)";
    case "slash":
      return step.command ? `/${step.command} (headless)` : "(no command chosen)";
    case "git_commit":
      return `message from ${step.messageFrom || "?"}`;
    case "git_push":
      return "push run branch";
    case "github_pr":
      return `title ${step.titleFrom || "?"} · body ${step.bodyFrom || "?"}`;
    case "intervention":
      return step.message?.split("\n")[0] || "wait for user";
    case "github_comment":
      return `on ${step.target || "?"} · body ${step.bodyFrom || "?"}`;
  }
}

export function FlowEditor() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const flow = useQuery({ queryKey: ["flow", id], queryFn: () => api.getFlow(id), enabled: !isNew });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });

  const [draft, setDraft] = useState<FlowDefinition | null>(isNew ? NEW_FLOW : null);
  const [saved, setSaved] = useState<FlowRow | null>(null);
  const [selection, setSelection] = useState<Selection>("inputs");
  const [tab, setTab] = useState<"canvas" | "json">("canvas");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (flow.data && (!saved || saved.id !== flow.data.id)) {
      setSaved(flow.data);
      setDraft(flow.data.definition);
    }
  }, [flow.data, saved]);

  const validation = useMemo(() => (draft ? validateFlow(draft) : null), [draft]);
  const errors = validation && !validation.ok ? validation.errors : [];
  const errorsByNode = useMemo(() => {
    const map = new Map<Selection, string[]>();
    for (const e of errors) {
      const m = /^steps\.(\d+)/.exec(e);
      const key: Selection = m ? Number(m[1]) : "inputs";
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return map;
  }, [errors]);

  const dirty = !!draft && (isNew || !saved || JSON.stringify(draft) !== JSON.stringify(saved.definition));

  const save = useMutation({
    mutationFn: (def: FlowDefinition) => (isNew ? api.createFlow(def) : api.updateFlow(id, def)),
    onSuccess: (row) => {
      setServerErrors([]);
      setSaved(row);
      setDraft(row.definition);
      qc.setQueryData(["flow", row.id], row);
      qc.invalidateQueries({ queryKey: ["flows"] });
      if (isNew) navigate(`/flows/${row.id}`, { replace: true });
    },
    onError: (err) =>
      setServerErrors(err instanceof ApiRequestError && err.errors.length ? err.errors : [errorMessage(err)]),
  });

  const { nodes, edges } = useMemo(() => {
    if (!draft) return { nodes: [] as Node[], edges: [] as Edge[] };
    const nodes: Node[] = [
      {
        id: "inputs",
        type: "chain",
        position: { x: 0, y: 0 },
        style: { width: NODE_WIDTH },
        data: {
          icon: pullRequestInputOf(draft) ? "⇄" : "⚙",
          title: "Trigger, Inputs & Workspace",
          subtitle: settingsSubtitle(draft),
          errors: errorsByNode.get("inputs") ?? [],
          selected: selection === "inputs",
        },
      } satisfies ChainNode,
      ...draft.steps.map(
        (step, idx): ChainNode => ({
          id: `step-${idx}`,
          type: "chain",
          position: { x: 0, y: (idx + 1) * ROW },
          style: { width: NODE_WIDTH },
          data: {
            icon: KIND_ICON[step.kind],
            title: step.name || "(unnamed step)",
            stepId: step.id,
            subtitle: `${KIND_LABEL[step.kind]} · ${stepSubtitle(step)}`,
            errors: errorsByNode.get(idx) ?? [],
            selected: selection === idx,
          },
        }),
      ),
      {
        id: "end",
        type: "end",
        position: { x: NODE_WIDTH / 2 - 24, y: (draft.steps.length + 1) * ROW },
        data: {},
        selectable: false,
      },
    ];
    const ids = nodes.map((n) => n.id);
    const edges: InsertEdge[] = ids.slice(1).map((target, idx) => ({
      id: `e-${idx}`,
      source: ids[idx]!,
      target,
      type: "insert",
      data: { onInsert: () => setInsertAt(idx) },
    }));
    return { nodes, edges };
  }, [draft, errorsByNode, selection]);

  if (!isNew && flow.error) return <p className="error pad">{errorMessage(flow.error)}</p>;
  if (!draft) return <p className="muted pad">Loading…</p>;

  const update = (next: FlowDefinition) => setDraft(next);
  const setSteps = (steps: Step[]) => update({ ...draft, steps });

  const insertStep = (kind: StepKind, at: number) => {
    let n = 1;
    while (draft.steps.some((s) => s.id === `${kind}_${n}`)) n++;
    const step = newStep(kind, `${kind}_${n}`, draft.steps.slice(0, at), draft.inputs);
    setSteps([...draft.steps.slice(0, at), step, ...draft.steps.slice(at)]);
    setSelection(at);
    setInsertAt(null);
  };

  const switchTab = (next: "canvas" | "json") => {
    if (next === "json") {
      setJsonText(JSON.stringify(draft, null, 2));
      setJsonError(null);
    }
    setTab(next);
  };

  const onJsonChange = (text: string) => {
    setJsonText(text);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return setJsonError(errorMessage(err));
    }
    const next = normalizeDraft(raw);
    if (typeof next === "string") return setJsonError(next);
    setJsonError(null);
    setDraft(next);
    if (typeof selection === "number" && selection >= next.steps.length) setSelection("inputs");
  };

  const selectedIdx = typeof selection === "number" && selection < draft.steps.length ? selection : null;

  return (
    <div className="editor">
      <div className="editor-header">
        <input
          className="title-input"
          value={draft.name}
          onChange={(e) => update({ ...draft, name: e.target.value })}
          aria-label="Flow name"
        />
        {saved && <span className="muted small">v{saved.version}</span>}
        {dirty && <span className="tag warn">unsaved</span>}
        <div className="tabs">
          <button type="button" className={tab === "canvas" ? "active" : ""} onClick={() => switchTab("canvas")}>
            Canvas
          </button>
          <button
            type="button"
            className={tab === "json" ? "active" : ""}
            onClick={() => switchTab("json")}
            disabled={tab === "json"}
          >
            JSON
          </button>
        </div>
        <span className="grow" />
        {errors.length > 0 && (
          <span className="tag error-tag" title={errors.join("\n")}>
            {errors.length} validation {errors.length === 1 ? "issue" : "issues"}
          </span>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={save.isPending || !dirty || jsonError !== null}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={isNew || dirty}
          title={isNew || dirty ? "Save the flow before running it" : undefined}
          onClick={() => setRunning(true)}
        >
          Run…
        </button>
      </div>
      {serverErrors.length > 0 && (
        <ul className="error-list banner">
          {serverErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {tab === "json" ? (
        <div className="json-editor">
          {jsonError && <p className="error">{jsonError}</p>}
          <textarea
            className="mono"
            spellCheck={false}
            value={jsonText}
            onChange={(e) => onJsonChange(e.target.value)}
          />
          {errors.length > 0 && (
            <ul className="error-list">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="editor-body">
          <div className="canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              colorMode="system"
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              fitView
              fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
              minZoom={0.3}
              maxZoom={1.5}
              panOnScroll
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_, node) => {
                if (node.id === "inputs") setSelection("inputs");
                else if (node.id.startsWith("step-")) setSelection(Number(node.id.slice(5)));
              }}
            />
          </div>
          <aside className="side-panel">
            {selectedIdx === null ? (
              <InputsPanel def={draft} errors={errorsByNode.get("inputs") ?? []} catalog={catalog.data} onChange={update} />
            ) : (
              <StepPanel
                key={selectedIdx}
                def={draft}
                index={selectedIdx}
                catalog={catalog.data}
                errors={errorsByNode.get(selectedIdx) ?? []}
                onChange={(step) => setSteps(draft.steps.map((s, i) => (i === selectedIdx ? step : s)))}
                onMove={(delta) => {
                  const to = selectedIdx + delta;
                  const steps = draft.steps.slice();
                  [steps[selectedIdx], steps[to]] = [steps[to]!, steps[selectedIdx]!];
                  setSteps(steps);
                  setSelection(to);
                }}
                onDelete={() => {
                  setSteps(draft.steps.filter((_, i) => i !== selectedIdx));
                  setSelection(selectedIdx > 0 ? selectedIdx - 1 : "inputs");
                }}
              />
            )}
          </aside>
        </div>
      )}

      {insertAt !== null && (
        <Modal title="Add step" onClose={() => setInsertAt(null)}>
          <div className="kind-grid">
            {STEP_KINDS.map((kind) => (
              <button key={kind} type="button" className="kind-card" onClick={() => insertStep(kind, insertAt)}>
                <span className="kind-icon">{KIND_ICON[kind]}</span>
                <strong>{KIND_LABEL[kind]}</strong>
                <small className="muted">{KIND_HELP[kind]}</small>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {running && saved && <RunDialog flow={saved} onClose={() => setRunning(false)} />}
    </div>
  );
}

const KIND_HELP: Record<StepKind, string> = {
  prompt: "Send a templated prompt to the agent",
  skill: "Apply a skill from the runner library",
  command: "Run a command template with arguments",
  slash: "Run a built-in omp slash command (e.g. review, plan) headless",
  git_commit: "Commit the worktree with a generated message",
  git_push: "Push the run branch to GitHub",
  github_pr: "Open a pull request from the run branch",
  intervention: "Pause and chat with the run's agent sessions, then continue",
  github_comment: "Post a comment on an issue or pull request input",
};

function RunDialog({ flow, onClose }: { flow: FlowRow; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const defs = flow.definition.inputs;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(defs.map((d) => [d.key, ""])),
  );
  const start = useMutation({
    mutationFn: () => api.startRun(flow.id, values),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/runs/${run.id}`);
    },
  });
  const missing = defs.filter((d) => d.required && !values[d.key]?.trim());

  return (
    <Modal
      title={`Run “${flow.name}”`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={missing.length > 0 || start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending ? "Starting…" : "Start run"}
          </button>
        </>
      }
    >
      {defs.length === 0 && <p className="muted">This flow has no inputs.</p>}
      {defs.map((d) => (
        <label key={d.key} className="field">
          <span>
            {d.label || d.key} {d.required && <span className="muted">*</span>}
          </span>
          {d.type === "text" ? (
            <textarea
              rows={3}
              value={values[d.key] ?? ""}
              onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}
            />
          ) : (
            <input
              type="url"
              placeholder={
                d.type === "github_pull_request"
                  ? "https://github.com/owner/repo/pull/123"
                  : "https://github.com/owner/repo/issues/123"
              }
              value={values[d.key] ?? ""}
              onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}
            />
          )}
        </label>
      ))}
      {start.error && <p className="error">{errorMessage(start.error)}</p>}
    </Modal>
  );
}
