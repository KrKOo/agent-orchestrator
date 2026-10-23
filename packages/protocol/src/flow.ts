import { z } from "zod";
import { templateRefs } from "./template";

export const ID_RE = /^[a-z][a-z0-9_]*$/;
export const DOMAIN_RE = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export const InputDef = z.object({
  key: z.string().regex(ID_RE, "input key must match /^[a-z][a-z0-9_]*$/"),
  label: z.string(),
  type: z.enum(["text", "github_issue"]),
  required: z.boolean().default(true),
});
export type InputDef = z.infer<typeof InputDef>;

/** Subfields exposed by a resolved `github_issue` input. */
export const GITHUB_ISSUE_FIELDS = ["url", "repo", "number", "title", "body"] as const;
export interface GitHubIssueInput {
  url: string;
  repo: string;
  number: number;
  title: string;
  body: string;
}

export const WorkspaceSpec = z.object({
  kind: z.literal("local_path"),
  path: z.string().refine((p) => p.startsWith("/"), "workspace.path must be absolute"),
  isolation: z.enum(["worktree", "direct"]).default("worktree"),
  baseRef: z.string().min(1).default("HEAD"),
  access: z.enum(["rw", "ro"]).default("rw"),
});
export type WorkspaceSpec = z.infer<typeof WorkspaceSpec>;

export const NetworkPolicy = z.object({
  mode: z.enum(["gateway_only", "allowlist", "open"]).default("gateway_only"),
  allow: z.array(z.string().regex(DOMAIN_RE, "allow entries must be domains like example.com or .example.com")).default([]),
});
export type NetworkPolicy = z.infer<typeof NetworkPolicy>;

export const SandboxSpec = z.object({
  provider: z.literal("docker").default("docker"),
  image: z.string().min(1).default("orch/sandbox-omp:latest"),
  network: NetworkPolicy.default({ mode: "gateway_only", allow: [] }),
  cpus: z.number().positive().default(2),
  memoryMb: z.number().int().positive().default(4096),
});
export type SandboxSpec = z.infer<typeof SandboxSpec>;

export const HarnessSpec = z.object({
  /** Harness adapter id ("omp"); the runner rejects ids it has no adapter for. */
  id: z.string().min(1),
  model: z.string().min(1),
  smolModel: z.string().min(1).optional(),
});
export type HarnessSpec = z.infer<typeof HarnessSpec>;

export const ManualTrigger = z.object({ kind: z.literal("manual") });
export const Trigger = z.discriminatedUnion("kind", [ManualTrigger]);
export type Trigger = z.infer<typeof Trigger>;

const stepBase = {
  id: z.string().regex(ID_RE, "step id must match /^[a-z][a-z0-9_]*$/"),
  name: z.string().min(1),
  timeoutSec: z.number().int().positive().default(1800),
};

export const PromptStep = z.object({
  ...stepBase,
  kind: z.literal("prompt"),
  prompt: z.string().min(1),
  freshSession: z.boolean().default(false),
});
export const SkillStep = z.object({
  ...stepBase,
  kind: z.literal("skill"),
  skill: z.string().min(1),
  args: z.string().optional(),
  freshSession: z.boolean().default(false),
});
export const CommandStep = z.object({
  ...stepBase,
  kind: z.literal("command"),
  command: z.string().min(1),
  args: z.string().optional(),
  freshSession: z.boolean().default(false),
});
export const GitCommitStep = z.object({
  ...stepBase,
  kind: z.literal("git_commit"),
  messageFrom: z.string().min(1),
});
export const GitPushStep = z.object({
  ...stepBase,
  kind: z.literal("git_push"),
});
export const GitHubPrStep = z.object({
  ...stepBase,
  kind: z.literal("github_pr"),
  titleFrom: z.string().min(1),
  bodyFrom: z.string().min(1),
  base: z.string().min(1).optional(),
  draft: z.boolean().default(false),
});

export const Step = z.discriminatedUnion("kind", [PromptStep, SkillStep, CommandStep, GitCommitStep, GitPushStep, GitHubPrStep]);
export type Step = z.infer<typeof Step>;
export type StepKind = Step["kind"];
export type AgentStep = Extract<Step, { kind: "prompt" | "skill" | "command" }>;
export type ActionStep = Extract<Step, { kind: "git_commit" | "git_push" | "github_pr" }>;
export const STEP_KINDS: StepKind[] = ["prompt", "skill", "command", "git_commit", "git_push", "github_pr"];

export function isAgentStep(step: Step): step is AgentStep {
  return step.kind === "prompt" || step.kind === "skill" || step.kind === "command";
}

export function isActionStep(step: Step): step is ActionStep {
  return !isAgentStep(step);
}

export const FlowDefinition = z.object({
  name: z.string().min(1),
  inputs: z.array(InputDef).default([]),
  workspace: WorkspaceSpec,
  sandbox: SandboxSpec.default({
    provider: "docker",
    image: "orch/sandbox-omp:latest",
    network: { mode: "gateway_only", allow: [] },
    cpus: 2,
    memoryMb: 4096,
  }),
  harness: HarnessSpec,
  approval: z.enum(["auto", "ask"]).default("auto"),
  runnerLabels: z.array(z.string().min(1)).default([]),
  trigger: Trigger.default({ kind: "manual" }),
  steps: z.array(Step).min(1, "flow needs at least one step"),
});
export type FlowDefinition = z.infer<typeof FlowDefinition>;
export type FlowDefinitionInput = z.input<typeof FlowDefinition>;

export type ValidateResult = { ok: true; flow: FlowDefinition } | { ok: false; errors: string[] };

/** Template-bearing fields of a step, as `[fieldName, template]` pairs. */
export function stepTemplates(step: Step): [string, string][] {
  switch (step.kind) {
    case "prompt":
      return [["prompt", step.prompt]];
    case "skill":
    case "command":
      return step.args === undefined ? [] : [["args", step.args]];
    default:
      return [];
  }
}

function checkRef(ref: string, inputs: Map<string, InputDef>, earlier: Set<string>): string | null {
  const parts = ref.split(".");
  if (parts[0] === "inputs") {
    const input = parts[1] === undefined ? undefined : inputs.get(parts[1]);
    if (!input) return `references undeclared input "${parts[1] ?? ""}"`;
    if (input.type === "text") return parts.length === 2 ? null : `text input "${input.key}" has no subfields`;
    if (parts.length === 2) return null;
    if (parts.length === 3 && (GITHUB_ISSUE_FIELDS as readonly string[]).includes(parts[2]!)) return null;
    return `github_issue input "${input.key}" exposes only ${GITHUB_ISSUE_FIELDS.join(", ")}`;
  }
  if (parts[0] === "steps") {
    const id = parts[1];
    if (id === undefined || !earlier.has(id)) return `references step "${id ?? ""}" which is not an earlier step`;
    if (parts[2] === "output" && parts.length === 3) return null;
    if (parts[2] === "structured") return null;
    return `step reference must be steps.<id>.output or steps.<id>.structured[...]`;
  }
  return `must start with inputs. or steps.`;
}

export function validateFlow(input: unknown): ValidateResult {
  const parsed = FlowDefinition.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)),
    };
  }
  const flow = parsed.data;
  const errors: string[] = [];

  const inputs = new Map<string, InputDef>();
  for (const def of flow.inputs) {
    if (inputs.has(def.key)) errors.push(`inputs: duplicate input key "${def.key}"`);
    inputs.set(def.key, def);
  }

  const seen = new Set<string>();
  const agentSteps = new Set<string>();
  let pushed = false;
  flow.steps.forEach((step, idx) => {
    const where = `steps.${idx} (${step.id})`;
    if (seen.has(step.id)) errors.push(`${where}: duplicate step id "${step.id}"`);

    for (const [field, tpl] of stepTemplates(step)) {
      for (const ref of templateRefs(tpl)) {
        const problem = checkRef(ref, inputs, seen);
        if (problem) errors.push(`${where}.${field}: {{${ref}}} ${problem}`);
      }
    }

    if (isActionStep(step) && (flow.workspace.isolation !== "worktree" || flow.workspace.access !== "rw")) {
      errors.push(`${where}: ${step.kind} requires workspace isolation "worktree" with access "rw"`);
    }
    const refFields: [string, string][] =
      step.kind === "git_commit"
        ? [["messageFrom", step.messageFrom]]
        : step.kind === "github_pr"
          ? [
              ["titleFrom", step.titleFrom],
              ["bodyFrom", step.bodyFrom],
            ]
          : [];
    for (const [field, ref] of refFields) {
      if (!agentSteps.has(ref)) errors.push(`${where}.${field}: "${ref}" must be an earlier prompt/skill/command step`);
    }
    if (step.kind === "git_push") pushed = true;
    if (step.kind === "github_pr" && !pushed) errors.push(`${where}: github_pr requires an earlier git_push step`);

    seen.add(step.id);
    if (isAgentStep(step)) agentSteps.add(step.id);
  });

  return errors.length ? { ok: false, errors } : { ok: true, flow };
}
