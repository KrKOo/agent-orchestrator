import { describe, expect, test } from "bun:test";
import {
  type FlowDefinition,
  isActionStep,
  isAgentStep,
  renderTemplate,
  TemplateError,
  templateRefs,
  templateVariables,
  validateFlow,
  validateInterventionSteps,
} from "../src";

const ctx = {
  inputs: { issue: { url: "u", repo: "o/r", number: 7, title: "Fix it", body: "Body" }, note: "hello" },
  steps: { plan: { output: "the plan", structured: { files: ["a.ts"] } } },
};

describe("renderTemplate", () => {
  test("substitutes strings raw, numbers as text and objects as JSON", () => {
    expect(
      renderTemplate("{{inputs.issue.title}} #{{ inputs.issue.number }} {{inputs.note}} {{steps.plan.structured}}", ctx),
    ).toBe('Fix it #7 hello {"files":["a.ts"]}');
  });

  test("unknown path throws TemplateError naming the path", () => {
    expect(() => renderTemplate("{{steps.nope.output}}", ctx)).toThrow(TemplateError);
    expect(() => renderTemplate("x {{inputs.issue.labels}}", ctx)).toThrow("Unknown template variable: inputs.issue.labels");
  });

  test("does not resolve inherited properties", () => {
    expect(() => renderTemplate("{{inputs.constructor}}", ctx)).toThrow("Unknown template variable: inputs.constructor");
  });

  test("templateRefs lists every reference", () => {
    expect(templateRefs("a {{x.y}} b {{ z }}")).toEqual(["x.y", "z"]);
  });
});

const baseFlow = {
  name: "f",
  inputs: [{ key: "issue", label: "Issue", type: "github_issue", required: true }],
  workspace: { kind: "local_path", path: "/repo", isolation: "worktree", baseRef: "HEAD", access: "rw" },
  harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
};

describe("validateFlow", () => {
  test("accepts a full implementation flow and applies defaults", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "Implement {{inputs.issue.title}}" },
        { id: "msg", name: "Msg", kind: "command", command: "commit-msg", args: "{{steps.impl.output}}" },
        { id: "commit", name: "Commit", kind: "git_commit", messageFrom: "msg" },
        { id: "push", name: "Push", kind: "git_push" },
        { id: "pr", name: "PR", kind: "github_pr", titleFrom: "msg", bodyFrom: "impl" },
      ],
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.flow.sandbox.network.mode).toBe("gateway_only");
    expect(res.flow.approval).toBe("auto");
    expect(res.flow.steps[0]!.timeoutSec).toBe(1800);
  });

  test("rejects forward step references in templates and *From fields", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "use {{steps.b.output}}" },
        { id: "c", name: "C", kind: "git_commit", messageFrom: "b" },
        { id: "b", name: "B", kind: "prompt", prompt: "hi" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => e.includes("{{steps.b.output}}"))).toBe(true);
    expect(res.errors.some((e) => e.includes("messageFrom"))).toBe(true);
  });

  test("rejects action steps under direct isolation", () => {
    const res = validateFlow({
      ...baseFlow,
      workspace: { ...baseFlow.workspace, isolation: "direct" },
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "hi" },
        { id: "c", name: "C", kind: "git_commit", messageFrom: "a" },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain('requires workspace isolation "worktree"');
  });

  test("rejects messageFrom pointing at an action step, undeclared inputs and bad issue subfields", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "{{inputs.missing}} {{inputs.issue.labels}}" },
        { id: "c", name: "C", kind: "git_commit", messageFrom: "a" },
        { id: "d", name: "D", kind: "git_commit", messageFrom: "c" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(3);
  });

  test("rejects github_pr without an earlier git_push and duplicate step ids", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "hi" },
        { id: "a", name: "A2", kind: "prompt", prompt: "hi" },
        { id: "pr", name: "PR", kind: "github_pr", titleFrom: "a", bodyFrom: "a" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => e.includes("duplicate step id"))).toBe(true);
    expect(res.errors.some((e) => e.includes("git_push"))).toBe(true);
  });

  test("rejects invalid allowlist domains", () => {
    const res = validateFlow({
      ...baseFlow,
      sandbox: { network: { mode: "allowlist", allow: ["http://evil.com"] } },
      steps: [{ id: "a", name: "A", kind: "prompt", prompt: "hi" }],
    });
    expect(res.ok).toBe(false);
  });

  test("accepts a slash step with args templates and rejects bad command names", () => {
    const ok = validateFlow({
      ...baseFlow,
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "Implement {{inputs.issue.title}}" },
        { id: "check", name: "Check", kind: "slash", command: "review", args: "focus on {{steps.impl.output}}" },
      ],
    });
    if (!ok.ok) throw new Error(ok.errors.join("\n"));
    expect(ok.flow.steps[1]!.kind).toBe("slash");

    const bad = validateFlow({
      ...baseFlow,
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "hi" },
        { id: "s", name: "S", kind: "slash", command: "bad name" },
        { id: "t", name: "T", kind: "slash", command: "" },
        { id: "u", name: "U", kind: "slash", command: "with space" },
      ],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.filter((e) => e.includes("command")).length).toBe(3);
  });

  test("accepts extra harness model roles and rejects default/smol and malformed role keys", () => {
    const ok = validateFlow({
      ...baseFlow,
      harness: { ...baseFlow.harness, modelRoles: { slow: "anthropic/claude-opus-4-5", plan: "litellm/glm-5.3" } },
      steps: [{ id: "a", name: "A", kind: "prompt", prompt: "hi" }],
    });
    if (!ok.ok) throw new Error(ok.errors.join("\n"));
    expect(ok.flow.harness.modelRoles).toEqual({ slow: "anthropic/claude-opus-4-5", plan: "litellm/glm-5.3" });

    const bad = validateFlow({
      ...baseFlow,
      harness: { ...baseFlow.harness, modelRoles: { default: "x/y", smol: "x/y", "bad key": "x/y" } },
      steps: [{ id: "a", name: "A", kind: "prompt", prompt: "hi" }],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((e) => e.includes("modelRoles.default: set harness.model instead"))).toBe(true);
    expect(bad.errors.some((e) => e.includes("modelRoles.smol: set harness.smolModel instead"))).toBe(true);
    expect(bad.errors.some((e) => e.includes("modelRoles.bad key: role must match"))).toBe(true);
  });

  test("accepts an intervention step with an optional timeout and templated message", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "Implement {{inputs.issue.title}}" },
        { id: "gate", name: "Review", kind: "intervention", message: "Check {{steps.impl.output}} before continuing" },
        { id: "after", name: "After", kind: "prompt", prompt: "{{steps.gate.output}}" },
      ],
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    const gate = res.flow.steps[1];
    expect(gate).toMatchObject({ kind: "intervention", message: "Check {{steps.impl.output}} before continuing" });
    expect(gate!.timeoutSec).toBeUndefined();

    const withTimeout = validateFlow({
      ...baseFlow,
      steps: [{ id: "gate", name: "Gate", kind: "intervention", message: "ok?", timeoutSec: 600 }],
    });
    if (!withTimeout.ok) throw new Error(withTimeout.errors.join("\n"));
    expect(withTimeout.flow.steps[0]!.timeoutSec).toBe(600);

    // message templates cannot reference later steps
    const fwd = validateFlow({
      ...baseFlow,
      steps: [
        { id: "gate", name: "Gate", kind: "intervention", message: "{{steps.after.output}}" },
        { id: "after", name: "After", kind: "prompt", prompt: "x" },
      ],
    });
    expect(fwd.ok).toBe(false);
  });
});

describe("intervention steps", () => {
  test("is not an action step", () => {
    const step = { id: "gate", name: "Gate", kind: "intervention" };
    expect(isActionStep(step as never)).toBe(false);
    expect(isAgentStep(step as never)).toBe(false);
  });

  test("validateInterventionSteps accepts prompt/slash/command referencing the gate and earlier steps", () => {
    const flow = validateFlow({
      ...baseFlow,
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "go" },
        { id: "gate", name: "Gate", kind: "intervention", message: "ok?" },
      ],
    });
    if (!flow.ok) throw new Error(flow.errors.join("\n"));
    const res = validateInterventionSteps(flow.flow, "gate", [
      { id: "fix", name: "Fix", kind: "prompt", prompt: "Fix per {{steps.gate.output}} and {{steps.impl.structured}}" },
      { id: "rv", name: "Review", kind: "slash", command: "review", args: "about {{steps.gate.output}}" },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.steps.map((s) => s.id)).toEqual(["fix", "rv"]);
  });

  test("validateInterventionSteps rejects action/skill/intervention kinds, duplicate ids, forward refs and >10", () => {
    const flow = validateFlow({
      ...baseFlow,
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "go" },
        { id: "gate", name: "Gate", kind: "intervention", message: "ok?" },
        { id: "later", name: "Later", kind: "prompt", prompt: "x" },
      ],
    });
    if (!flow.ok) throw new Error(flow.errors.join("\n"));

    const kinds = validateInterventionSteps(flow.flow, "gate", [
      { id: "a", name: "A", kind: "git_push" },
      { id: "b", name: "B", kind: "skill", skill: "x" },
      { id: "c", name: "C", kind: "intervention" },
    ]);
    expect(kinds.ok).toBe(false);
    if (!kinds.ok) expect(kinds.errors.filter((e) => e.includes("cannot be added")).length).toBe(3);

    const dup = validateInterventionSteps(flow.flow, "gate", [{ id: "impl", name: "Dup", kind: "prompt", prompt: "x" }]);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.join()).toContain('duplicate step id "impl"');

    const laterDup = validateInterventionSteps(flow.flow, "gate", [{ id: "later", name: "Dup", kind: "prompt", prompt: "x" }]);
    expect(laterDup.ok).toBe(false);

    const fwd = validateInterventionSteps(flow.flow, "gate", [
      { id: "a", name: "A", kind: "prompt", prompt: "{{steps.later.output}}" },
    ]);
    expect(fwd.ok).toBe(false);

    const many = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, kind: "prompt", prompt: "x" }));
    const tooMany = validateInterventionSteps(flow.flow, "gate", many);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.errors.join()).toContain("at most 10");
  });

  test("validateFlow rejects intervention steps in pull request flows", () => {
    const res = validateFlow({
      ...prFlow,
      steps: [...prFlow.steps, { id: "gate", name: "Gate", kind: "intervention", message: "ok?" }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain("cannot contain intervention steps");
  });
});

const prFlow = {
  name: "pr-check",
  inputs: [],
  workspace: { kind: "github_checkout" },
  harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
  trigger: { kind: "github_pull_request", repos: ["o/r"] },
  steps: [{ id: "review", name: "Review", kind: "prompt", prompt: "Review {{inputs.pr.title}} using {{inputs.pr.diffPath}}" }],
};

describe("validateFlow for github_pull_request flows", () => {
  test("accepts a PR check flow and applies trigger defaults", () => {
    const res = validateFlow(prFlow);
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.flow.trigger).toEqual({
      kind: "github_pull_request",
      repos: ["o/r"],
      events: ["opened", "synchronize", "reopened", "ready_for_review"],
      forkPolicy: "require_approval",
      postReview: true,
    });
  });

  test("rejects local workspaces, action steps, ask approval, open network, inputs and unknown pr fields", () => {
    const res = validateFlow({
      ...prFlow,
      workspace: { kind: "local_path", path: "/repo" },
      approval: "ask",
      sandbox: { network: { mode: "open", allow: [] } },
      inputs: [{ key: "x", label: "X", type: "text" }],
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "{{inputs.pr.author}}" },
        { id: "c", name: "C", kind: "git_commit", messageFrom: "a" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const all = res.errors.join("\n");
    for (const needle of ["github_checkout", 'approval "auto"', '"open"', "take no inputs", "inputs.pr exposes only", "cannot contain git_commit"]) {
      expect(all).toContain(needle);
    }
  });

  test("rejects github_checkout on manual flows", () => {
    const res = validateFlow({ ...prFlow, trigger: { kind: "manual" }, steps: [{ id: "a", name: "A", kind: "prompt", prompt: "hi" }] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain("requires a github_pull_request trigger");
  });
});

describe("templateVariables", () => {
  const parse = (def: unknown): FlowDefinition => {
    const res = validateFlow(def);
    if (!res.ok) throw new Error(res.errors.join("\n"));
    return res.flow;
  };
  /** Replaces step `idx` with a prompt referencing every listed variable; the flow must still validate. */
  const expectAllValid = (def: FlowDefinition, idx: number) => {
    const prompt = templateVariables(def, idx).map((v) => `{{${v.path}}}`).join(" ");
    const steps = def.steps.map((s, i) => (i === idx ? { id: s.id, name: s.name, kind: "prompt", prompt } : s));
    parse({ ...def, steps });
  };

  test("lists inputs and earlier steps only, with structured just for agent steps", () => {
    const def = parse({
      ...baseFlow,
      inputs: [...baseFlow.inputs, { key: "note", label: "Note", type: "text", required: false }],
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "go" },
        { id: "commit", name: "Commit", kind: "git_commit", messageFrom: "impl" },
        { id: "review", name: "Review", kind: "prompt", prompt: "check" },
        { id: "later", name: "Later", kind: "prompt", prompt: "x" },
      ],
    });
    const paths = templateVariables(def, 2).map((v) => v.path);
    expect(paths).toEqual([
      "inputs.issue",
      "inputs.issue.url",
      "inputs.issue.repo",
      "inputs.issue.number",
      "inputs.issue.title",
      "inputs.issue.body",
      "inputs.note",
      "steps.impl.output",
      "steps.impl.structured",
      "steps.commit.output",
    ]);
    expect(templateVariables(def, 0).some((v) => v.path.startsWith("steps."))).toBe(false);
    for (let i = 0; i < def.steps.length; i++) expectAllValid(def, i);
  });

  test("pull request flows expose inputs.pr and its fields", () => {
    const def = parse({
      ...prFlow,
      steps: [...prFlow.steps, { id: "summary", name: "Summary", kind: "prompt", prompt: "sum up" }],
    });
    const paths = templateVariables(def, 1).map((v) => v.path);
    expect(paths).toContain("inputs.pr");
    expect(paths).toContain("inputs.pr.diffPath");
    expect(paths).toContain("steps.review.structured");
    expectAllValid(def, 1);
  });
});
