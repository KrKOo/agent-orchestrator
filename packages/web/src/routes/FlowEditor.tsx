import {
  branchBlocks,
  choiceGateOf,
  conditionBranches,
  type ConditionStep,
  type FlowDefinition,
  type FlowRow,
  isAgentStep,
  isTextStep,
  loopRanges,
  pullRequestInputOf,
  type Step,
  STEP_KINDS,
  type StepKind,
  templateVariables,
  validateFlow,
} from "@orch/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BaseEdge,
  Controls,
  type Edge,
  type EdgeProps,
  EdgeLabelRenderer,
  getStraightPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { ArrowLeftRight, Plus, Settings2, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { type Blocker, useBlocker, useNavigate, useParams } from "react-router";
import { ApiRequestError, api, errorMessage } from "../api";
import { DEFAULT_LOCAL_WORKSPACE, InputsPanel } from "../components/InputsPanel";
import { KIND_LABEL, conditionSubtitle, loopStopSubtitle, StepPanel } from "../components/StepPanel";
import { RunDialog } from "../components/RunDialog";
import { KindIcon } from "../components/icons";
import { Modal, Popover, Skeleton, usePageTitle } from "../ui";
import { useToast } from "../components/Toast";

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

/**
 * A new If… step inserted at `at`: it compares the last value available there and ends its then-block at the
 * first later step that adds no validation error (nested in enclosing branches, not crossing a loop body, later
 * refs still valid). Without such a step `thenEnd` names the condition itself, an ordinary "must be a later step"
 * error instead of a schema failure that would hide the flow's other errors.
 */
function newCondition(def: FlowDefinition, id: string, at: number): ConditionStep {
  const withStep = (step: ConditionStep): FlowDefinition => ({ ...def, steps: [...def.steps.slice(0, at), step, ...def.steps.slice(at)] });
  const errorCount = (step: ConditionStep): number => {
    const res = validateFlow(withStep(step));
    return res.ok ? 0 : res.errors.length;
  };
  let step: ConditionStep = { id, name: "If", kind: "condition", ref: "inputs", op: "truthy", thenEnd: id };
  const ref = templateVariables(withStep(step), at).at(-1)?.path;
  if (ref) {
    // A choice gate compares with equals against one of its choice ids.
    const gate = choiceGateOf(def, ref);
    step = { ...step, ref, ...(gate ? { op: "equals" as const, value: gate.choices![0]!.id } : {}) };
  }
  const baseline = errorCount(step);
  const thenEnd = def.steps.slice(at).find((s) => errorCount({ ...step, thenEnd: s.id }) < baseline)?.id;
  return thenEnd ? { ...step, thenEnd } : step;
}

function newStep(kind: StepKind, id: string, def: FlowDefinition, at: number): Step {
  const base = { id, name: KIND_LABEL[kind], timeoutSec: 1800 };
  const earlier = def.steps.slice(0, at);
  const inputs = def.inputs;
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
    case "shell":
      return { ...base, kind, command: "" };
    case "git_snapshot":
      return { ...base, kind, since: "previous" };
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
    case "loop":
      return {
        id,
        name: "Loop",
        kind,
        to: earlier.findLast((s) => s.kind !== "loop")?.id ?? "",
        maxIterations: 3,
        stop: { when: "max" },
        onExhausted: "continue",
      };
    case "condition":
      return newCondition(def, id, at);
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

type Selection = "inputs" | number | null;

interface ChainNodeData extends Record<string, unknown> {
  /** Step kind rendered as its lucide glyph; absent on the settings node, which has a static gear. */
  kind?: StepKind;
  /** Settings node only: renders the swap glyph (PR-checkout workspace) instead of the gear. */
  swap?: boolean;
  title: string;
  /** Step id shown as a badge; absent on the settings node. */
  stepId?: string;
  subtitle: string;
  errors: string[];
  selected: boolean;
  /** Loop step: rendered compact, with the handle its back-edge leaves from. */
  loop?: boolean;
  /** Condition branch this step sits in: a small tag in the node head. */
  branch?: "then" | "else";
}
type ChainNode = Node<ChainNodeData, "chain">;

interface InsertEdgeData extends Record<string, unknown> {
  onInsert: () => void;
}
type InsertEdge = Edge<InsertEdgeData, "insert">;

interface LoopEdgeData extends Record<string, unknown> {
  /** Horizontal distance of the arrow's vertical run from the nodes; outer loops get more. */
  offset: number;
}
type LoopEdge = Edge<LoopEdgeData, "loop">;

function ChainNodeView({ data }: NodeProps<ChainNode>) {
  return (
    <div className={`chain-node ${data.loop ? "loop" : ""} ${data.selected ? "selected" : ""} ${data.errors.length ? "invalid" : ""}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="kind-icon">
        {data.kind ? (
          <KindIcon kind={data.kind} size={15} />
        ) : data.swap ? (
          <ArrowLeftRight size={15} aria-hidden />
        ) : (
          <Settings2 size={15} aria-hidden />
        )}
      </span>
      <div className="chain-node-text">
        <div className="chain-node-head">
          <span className="chain-node-title">{data.title}</span>
          {data.stepId !== undefined && (
            <span className="step-id" title="Step id">
              {data.stepId || "(no id)"}
            </span>
          )}
          {data.branch && (
            <span className="tag branch-tag" title={`Step of the ${data.branch} branch of the condition above`}>
              {data.branch}
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
      {/* Declared after the chain handles: edges without a handle id take the first one (top/bottom). */}
      <Handle type="target" id="loop-in" position={Position.Right} isConnectable={false} />
      {data.loop && <Handle type="source" id="loop-out" position={Position.Right} isConnectable={false} />}
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
          aria-label="Insert step here"
        >
          <Plus size={14} aria-hidden />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

/** Back-arrow of a loop: out of the loop node's right side, up beside the body, into the `to` step's right side. */
function LoopEdgeView({ id, sourceX, sourceY, targetX, targetY, data, markerEnd }: EdgeProps<LoopEdge>) {
  const x = Math.max(sourceX, targetX) + (data?.offset ?? 24);
  const r = 8;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${x - r} ${sourceY}`,
    `Q ${x} ${sourceY} ${x} ${sourceY - r}`,
    `L ${x} ${targetY + r}`,
    `Q ${x} ${targetY} ${x - r} ${targetY}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} className="loop-edge" />;
}

const nodeTypes = { chain: ChainNodeView, end: EndNodeView };
const edgeTypes = { insert: InsertEdgeView, loop: LoopEdgeView };

const NODE_WIDTH = 300;
const LOOP_NODE_WIDTH = 240;
const ROW = 110;
/** Horizontal spacing between nested loops' back-arrows. */
const LOOP_EDGE_STEP = 22;
/** Indent per branch nesting level: steps inside a condition's branch sit this far to the right. */
const BRANCH_INDENT = 70;

/**
 * Nesting height per loop step index: 1 for loops with no loop inside their body, else one more than the
 * tallest inner loop, so outer back-arrows run outside inner ones.
 */
function loopHeights(ranges: Map<number, number>): Map<number, number> {
  const heights = new Map<number, number>();
  for (const [end, start] of [...ranges].sort(([e1, s1], [e2, s2]) => e1 - s1 - (e2 - s2))) {
    let h = 1;
    for (const [e, s] of ranges) if (e !== end && start <= s && e < end) h = Math.max(h, (heights.get(e) ?? 0) + 1);
    heights.set(end, h);
  }
  return heights;
}

/** Subtitle of the "Trigger, Inputs & Workspace" node. */
function settingsSubtitle(def: FlowDefinition): string {
  if (def.trigger.kind === "github_pull_request") {
    return `on PRs · ${def.trigger.repos.join(", ") || "(no repositories)"}`;
  }
  if (pullRequestInputOf(def)) return "manual · pull request checkout";
  return def.workspace.kind === "local_path" ? def.workspace.path || "(choose a workspace path)" : "manual";
}

function stepSubtitle(step: Step, def: FlowDefinition): string {
  switch (step.kind) {
    case "prompt":
      return step.prompt.split("\n")[0] || "(empty prompt)";
    case "skill":
      return step.skill || "(no skill chosen)";
    case "command":
      return step.command ? `/${step.command}` : "(no command chosen)";
    case "slash":
      return step.command ? `/${step.command} (headless)` : "(no command chosen)";
    case "shell":
      return step.command.split("\n")[0] || "(empty command)";
    case "git_snapshot":
      return step.since === "start" ? "diff since run start" : "diff since previous pass";
    case "git_commit":
      return `message from ${step.messageFrom || "?"}`;
    case "git_push":
      return "push run branch";
    case "github_pr":
      return `title ${step.titleFrom || "?"} · body ${step.bodyFrom || "?"}`;
    case "intervention":
      return step.choices ? `choices: ${step.choices.map((c) => c.label || c.id).join(" / ")}` : step.message?.split("\n")[0] || "wait for user";
    case "github_comment":
      return `on ${step.target || "?"} · body ${step.bodyFrom || "?"}`;
    case "loop":
      return loopStopSubtitle(step.stop, step.maxIterations);
    case "condition":
      return conditionSubtitle(step, def);
  }
}

export function FlowEditor() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const flow = useQuery({ queryKey: ["flow", id], queryFn: () => api.getFlow(id), enabled: !isNew });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });

  usePageTitle(isNew ? "New flow" : flow.data ? `Flow · ${flow.data.name}` : "Flow");

  const [draft, setDraft] = useState<FlowDefinition | null>(isNew ? NEW_FLOW : null);
  const [saved, setSaved] = useState<FlowRow | null>(null);
  const [selection, setSelection] = useState<Selection>("inputs");
  const [tab, setTab] = useState<"canvas" | "json">("canvas");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => loadPanelWidth());
  const [blockerOpen, setBlockerOpen] = useState(false);
  // Mobile drawer (<1024px) visibility, independent of `selection`: the docked panel always shows
  // something on wide screens, while the drawer opens only when a node is picked.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The run dialog the Save & run mutation opens once its save succeeds.
  const pendingRunRef = useRef(false);
  // Set by a successful first save right before its /flows/new → /flows/:id replace: the dirty state hasn't
  // cleared yet when navigate() runs, but that navigation must not prompt. Not set while the save is in
  // flight, so leaving mid-save still prompts (a failed save would otherwise lose the edits).
  const skipBlockerRef = useRef(false);
  // Set when the unsaved-changes dialog's Save should continue the blocked navigation on success; cleared
  // by Stay/Escape so a slow save can't yank the user away after they chose to remain.
  const proceedAfterSaveRef = useRef(false);
  // Latest blocker handle: onSuccess above can't close over `blocker` (declared later by hook order).
  const blockerRef = useRef<Blocker | null>(null);
  /** Latest Cmd/Ctrl+S action (assigned each render once the draft is loaded); the window listener calls it. */
  const saveShortcutRef = useRef<() => void>(() => {});
  /** Latest draft, for the delete toast's Undo, which runs after later edits may have changed it. */
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (flow.data && (!saved || saved.id !== flow.data.id)) {
      setSaved(flow.data);
      setDraft(flow.data.definition);
    }
  }, [flow.data, saved]);

  const validation = useMemo(() => (draft ? validateFlow(draft) : null), [draft]);
  const valid = validation?.ok ?? false;
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

  // `edited`: the draft differs from what's stored (NEW_FLOW for an unsaved new flow); drives the leave
  // guards, since an untouched new flow has nothing to lose. `dirty`: Save applies, which includes any new flow.
  const baseline = saved?.definition ?? (isNew ? NEW_FLOW : null);
  const edited = !!draft && (!baseline || JSON.stringify(draft) !== JSON.stringify(baseline));
  const dirty = !!draft && (isNew || edited);

  const save = useMutation({
    mutationFn: (def: FlowDefinition) => (isNew ? api.createFlow(def) : api.updateFlow(id, def)),
    onSuccess: (row) => {
      setServerErrors([]);
      setSaved(row);
      setDraft(row.definition);
      qc.setQueryData(["flow", row.id], row);
      qc.invalidateQueries({ queryKey: ["flows"] });
      if (isNew) {
        skipBlockerRef.current = true;
        navigate(`/flows/${row.id}`, { replace: true });
      }
      toast("Flow saved", { kind: "success" });
      if (pendingRunRef.current) {
        pendingRunRef.current = false;
        setRunning(true);
      }
      if (proceedAfterSaveRef.current) {
        proceedAfterSaveRef.current = false;
        blockerRef.current?.proceed?.();
      }
    },
    onError: (err) => {
      pendingRunRef.current = false;
      setServerErrors(err instanceof ApiRequestError && err.errors.length ? err.errors : [errorMessage(err)]);
    },
  });

  // Remember the side panel width across visits.
  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

  // Below 1024px the side panel is a drawer; Escape deselects (closes it) without leaving the editor.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Skip when a dialog already handled it: Modal's Escape fires on the dialog element (this window
      // listener is the fallback that would otherwise close the drawer too).
      if (e.target instanceof Element && e.target.closest(".modal")) return;
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const startPanelDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMove = (ev: PointerEvent) => {
      ev.preventDefault();
      setPanelWidth(clampPanelWidth(startWidth + startX - ev.clientX));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
  };

  const onPanelResizeKey = (e: ReactKeyboardEvent) => {
    const step = e.key === "ArrowLeft" ? PANEL_STEP : e.key === "ArrowRight" ? -PANEL_STEP : 0;
    if (!step) return;
    e.preventDefault();
    setPanelWidth(clampPanelWidth(panelWidth + step));
  };

  const { nodes, edges } = useMemo(() => {
    if (!draft) return { nodes: [] as Node[], edges: [] as Edge[] };
    // Branch nesting per step index: steps inside a condition's then/else block sit one level further
    // right; a step in two nested branches is indented twice. Innermost wins for the tag.
    const branches = conditionBranches(draft);
    const blocks = branchBlocks(branches);
    const nodes: Node[] = [
      {
        id: "inputs",
        type: "chain",
        position: { x: 0, y: 0 },
        style: { width: NODE_WIDTH },
        data: {
          swap: !!pullRequestInputOf(draft),
          title: "Trigger, Inputs & Workspace",
          subtitle: settingsSubtitle(draft),
          errors: errorsByNode.get("inputs") ?? [],
          selected: selection === "inputs",
        },
      } satisfies ChainNode,
      ...draft.steps.map((step, idx): ChainNode => {
        const loop = step.kind === "loop";
        const condition = step.kind === "condition";
        const width = loop ? LOOP_NODE_WIDTH : NODE_WIDTH;
        const target = loop ? draft.steps.find((s, i) => i < idx && s.id === step.to) : undefined;
        const depth = blocks.filter((b) => b.start <= idx && idx <= b.end).length;
        return {
          id: `step-${idx}`,
          type: "chain",
          position: {
            x: (NODE_WIDTH - width) / 2 + depth * BRANCH_INDENT,
            y: (idx + 1) * ROW,
          },
          style: { width },
          data: {
            kind: step.kind,
            title: loop ? `Repeat from ${target?.name || step.to || "?"}` : step.name || "(unnamed step)",
            stepId: step.id,
            subtitle: loop ? stepSubtitle(step, draft) : `${KIND_LABEL[step.kind]} · ${stepSubtitle(step, draft)}`,
            errors: errorsByNode.get(idx) ?? [],
            selected: selection === idx,
            loop,
            branch: condition ? undefined : blocks.findLast((b) => b.start <= idx && idx <= b.end)?.branch,
          },
        };
      }),
      {
        id: "end",
        type: "end",
        position: { x: NODE_WIDTH / 2 - 24, y: (draft.steps.length + 1) * ROW },
        data: {},
        selectable: false,
      },
    ];
    const ids = nodes.map((n) => n.id);
    const edges: (InsertEdge | LoopEdge)[] = ids.slice(1).map((target, idx) => ({
      id: `e-${idx}`,
      source: ids[idx]!,
      target,
      type: "insert",
      data: { onInsert: () => setInsertAt(idx) },
    }));
    const ranges = loopRanges(draft);
    const heights = loopHeights(ranges);
    for (const [end, start] of ranges) {
      edges.push({
        id: `loop-${end}`,
        source: `step-${end}`,
        sourceHandle: "loop-out",
        target: `step-${start}`,
        targetHandle: "loop-in",
        type: "loop",
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--accent)", width: 16, height: 16 },
        data: { offset: LOOP_EDGE_STEP * heights.get(end)! },
      });
    }
    return { nodes, edges };
  }, [draft, errorsByNode, selection]);

  // The unsaved-changes guard: one blocker while `edited` backs both the dialog and the tab-close warning.
  // Don't block navigation to the same flow (the /flows/new → /flows/:id replace after the first save)
  // or to the run the editor itself opens via Save & run. Hooks stay above the early returns below:
  // useBlocker must subscribe on every render, loaded flow or not.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (skipBlockerRef.current) {
      skipBlockerRef.current = false;
      return false;
    }
    return (
      edited &&
      !(nextLocation.pathname === currentLocation.pathname && nextLocation.search === currentLocation.search) &&
      !nextLocation.pathname.startsWith("/runs/")
    );
  });
  useEffect(() => {
    if (blocker.state === "blocked") setBlockerOpen(true);
  }, [blocker.state]);
  blockerRef.current = blocker;
  useEffect(() => {
    if (!edited) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [edited]);
  // Cmd/Ctrl+S saves anywhere on the page (and never opens the browser's save-page dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      saveShortcutRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!isNew && flow.error) return <p className="error pad">{errorMessage(flow.error)}</p>;
  if (!draft) return <Skeleton rows={4} />;

  const selectedIdx = typeof selection === "number" && selection < draft.steps.length ? selection : null;
  const update = (next: FlowDefinition) => setDraft(next);
  const setSteps = (steps: Step[]) => update({ ...draft, steps });

  const insertStep = (kind: StepKind, at: number) => {
    let n = 1;
    while (draft.steps.some((s) => s.id === `${kind}_${n}`)) n++;
    const step = newStep(kind, `${kind}_${n}`, draft, at);
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

  /**
   * Whether `draft` is what the user sees and may be saved. While the JSON tab holds unparseable text, `draft`
   * is the last version that parsed: saving (or running) it would act on a definition the user isn't looking at.
   */
  const checkSavable = (): boolean => {
    if (jsonError !== null) {
      toast("Fix the JSON before saving", { kind: "error" });
      return false;
    }
    if (!valid) {
      toast("Fix the validation issues before saving", { kind: "error" });
      return false;
    }
    return true;
  };
  const saveDraft = () => {
    if (!draft || save.isPending) return;
    if (!checkSavable()) {
      setServerErrors([]);
      return;
    }
    save.mutate(draft);
  };
  // Clean drafts have nothing to save.
  saveShortcutRef.current = () => {
    if (dirty) saveDraft();
  };
  const closeBlockerDialog = () => {
    proceedAfterSaveRef.current = false;
    setBlockerOpen(false);
    blocker.reset?.();
  };

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
          <Popover
            label={`${errors.length} validation issues`}
            buttonClassName="issues-btn tag error-tag"
            button={errors.length === 1 ? "1 issue" : `${errors.length} issues`}
            placement="below"
          >
            {(close) => (
              <div className="issues-menu">
                <div className="issues-menu-title">Validation issues</div>
                {errors.map((e) => {
                  const m = /^steps\.(\d+)/.exec(e);
                  const target: Selection = m ? Number(m[1]) : "inputs";
                  const label = m
                    ? draft.steps[Number(m[1])]?.name || draft.steps[Number(m[1])]?.id || `Step ${Number(m[1]) + 1}`
                    : "Trigger, inputs & workspace";
                  return (
                    <button
                      key={e}
                      type="button"
                      className="menu-item issues-item"
                      onClick={() => {
                        setSelection(target);
                        close();
                      }}
                    >
                      <span className="issues-item-target">{label}</span>
                      <span className="issues-item-text">{e}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </Popover>
        )}
        <button type="button" className="btn primary" disabled={save.isPending || !dirty || jsonError !== null} onClick={saveDraft}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!valid || jsonError !== null}
          title={isNew || dirty ? "Save the flow, then choose what to run" : "Run this saved flow"}
          onClick={() => {
            if (!dirty) {
              setRunning(true);
              return;
            }
            if (!draft || save.isPending || !checkSavable()) return;
            pendingRunRef.current = true;
            save.mutate(draft);
          }}
        >
          {dirty ? "Save & run" : "Run…"}
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
            aria-label="Flow definition (JSON)"
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
                setDrawerOpen(true);
                if (node.id === "inputs") setSelection("inputs");
                else if (node.id.startsWith("step-")) setSelection(Number(node.id.slice(5)));
              }}
              onPaneClick={() => {
                setDrawerOpen(true);
                setSelection("inputs");
              }}
            >
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
          </div>
          {drawerOpen && (
            <button
              type="button"
              className="flow-drawer-backdrop open"
              aria-label="Close settings panel"
              onClick={() => setDrawerOpen(false)}
            />
          )}
          <aside className={`side-panel${drawerOpen ? " panel-open" : ""}`} style={{ width: panelWidth }}>
            <button
              type="button"
              className="panel-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panel"
              aria-valuenow={panelWidth}
              aria-valuemin={PANEL_MIN}
              aria-valuemax={PANEL_MAX}
              onPointerDown={startPanelDrag}
              onKeyDown={onPanelResizeKey}
            />
            {/* Drawer close: below 1024px the panel overlays the canvas; on wide screens it is display:none. */}
            <button type="button" className="icon-btn panel-close" aria-label="Close settings panel" onClick={() => setDrawerOpen(false)}>
              <X size={16} aria-hidden />
            </button>
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
                  // Undo re-inserts only this step (at its old index, clamped): edits made while the toast is
                  // up survive, unlike restoring a whole-draft snapshot.
                  const index = selectedIdx;
                  const removed = draft.steps[index]!;
                  setSteps(draft.steps.filter((_, i) => i !== index));
                  setSelection(index > 0 ? index - 1 : "inputs");
                  toast("Step deleted", {
                    action: {
                      label: "Undo",
                      onAction: () => {
                        const at = Math.min(index, draftRef.current?.steps.length ?? 0);
                        setDraft((cur) => cur && { ...cur, steps: [...cur.steps.slice(0, at), removed, ...cur.steps.slice(at)] });
                        setSelection(at);
                      },
                    },
                  });
                }}
              />
            )}
          </aside>
        </div>
      )}

      {insertAt !== null && (
        <AddStepDialog at={insertAt} onPick={(kind) => insertStep(kind, insertAt)} onClose={() => setInsertAt(null)} />
      )}
      {blocker.state === "blocked" && blockerOpen && (
        <Modal
          title="Unsaved changes"
          onClose={closeBlockerDialog}
          footer={
            <>
              <button type="button" className="btn" onClick={closeBlockerDialog}>
                Stay
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  setDraft(saved?.definition ?? (isNew ? NEW_FLOW : draft));
                  setSelection("inputs");
                  setBlockerOpen(false);
                  blocker.proceed?.();
                }}
              >
                Discard
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={save.isPending}
                onClick={() => {
                  if (!draft) return;
                  if (!checkSavable()) {
                    // Stay on the page: the header shows what to fix.
                    closeBlockerDialog();
                    return;
                  }
                  // Save, then continue the blocked navigation on success; onError clears the flag.
                  proceedAfterSaveRef.current = true;
                  save.mutate(draft);
                }}
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </>
          }
        >
          <p>You edited this flow but didn't save. Leave without saving?</p>
          {(errors.length > 0 || jsonError !== null) && (
            <p className="error small">Fix the validation issues first — the flow can't be saved as-is.</p>
          )}
        </Modal>
      )}
      {running && saved && <RunDialog flow={saved} onClose={() => setRunning(false)} />}
    </div>
  );
}

const PANEL_MIN = 320;
const PANEL_MAX = 720;
const PANEL_STEP = 24;
const PANEL_WIDTH_KEY = "orch.flowEditor.panelWidth";

function loadPanelWidth(): number {
  const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  return Number.isFinite(stored) && stored >= PANEL_MIN && stored <= PANEL_MAX ? stored : 440;
}

/** Drag and arrow-key resizing clamp into [PANEL_MIN, PANEL_MAX]. */
function clampPanelWidth(width: number): number {
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, width));
}

const KIND_HELP: Record<StepKind, string> = {
  prompt: "Send a templated prompt to the agent; optionally declare structured output fields (submit_output)",
  skill: "Apply a skill from the runner library",
  command: "Run a command template with arguments",
  slash: "Run a built-in omp slash command (e.g. review, plan) headless",
  shell: "Run a bash command in the sandbox; its stdout feeds later steps",
  git_snapshot: "Record the workspace and diff it against the previous pass or the run start (for incremental reviews)",
  git_commit: "Commit the worktree with a generated message",
  git_push: "Push the run branch to GitHub",
  github_pr: "Open a pull request from the run branch",
  intervention: "Pause and chat with the run's agent sessions, then continue",
  github_comment: "Post a comment on an issue or pull request input",
  loop: "Jump back to an earlier step: repeat a fixed count, until a value is truthy/falsy, or ask each time",
  condition: "Branch on a value: run a then-block, optionally an else-block; the other branch is skipped",
};

/** "Add step" dialog: a filter box plus the 2-column kind grid; arrows move focus, Enter picks. */
function AddStepDialog({ at, onPick, onClose }: { at: number; onPick: (kind: StepKind) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const kinds = STEP_KINDS.filter(
    (kind) => KIND_LABEL[kind].toLowerCase().includes(needle) || KIND_HELP[kind].toLowerCase().includes(needle),
  );
  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const stepX = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const stepY = e.key === "ArrowDown" ? 2 : e.key === "ArrowUp" ? -2 : 0;
    if (!stepX && !stepY) return;
    e.preventDefault();
    const cards = e.currentTarget.querySelectorAll<HTMLButtonElement>(".kind-card");
    if (cards.length === 0) return;
    const current = [...cards].indexOf(document.activeElement as HTMLButtonElement);
    // Nothing focused (filter input had focus): arrows start at the first card; off-grid targets clamp.
    const next = Math.max(0, Math.min(cards.length - 1, (current === -1 ? 0 : current) + (stepX || stepY)));
    cards[next]?.focus();
  };
  return (
    <Modal title={`Insert step at ${at + 1}`} onClose={onClose}>
      <input
        type="text"
        placeholder="Filter step kinds…"
        aria-label="Filter step kinds"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {kinds.length === 0 ? (
        <p className="muted kind-grid-empty">No step kinds match “{query}”.</p>
      ) : (
        <div className="kind-grid" onKeyDown={onGridKeyDown}>
          {kinds.map((kind) => (
            <button key={kind} type="button" className="kind-card" onClick={() => onPick(kind)}>
              <span className="kind-icon">
                <KindIcon kind={kind} size={15} />
              </span>
              <strong>{KIND_LABEL[kind]}</strong>
              <small className="muted">{KIND_HELP[kind]}</small>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
