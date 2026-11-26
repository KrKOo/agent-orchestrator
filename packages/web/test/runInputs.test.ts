import { flowBindings, materializeFlow, validateFlow } from "@orch/protocol";
import { describe, expect, test } from "bun:test";
import { initialInputValue } from "../src/runInputs";

describe("initialInputValue", () => {
  const v = validateFlow({
    name: "f",
    inputs: [
      { key: "model", label: "Model", type: "model", required: false },
      { key: "small", label: "Small", type: "model", required: false },
      { key: "cpus", label: "CPUs", type: "number", required: false, default: 4 },
    ],
    workspace: { kind: "local_path", path: "/repo" },
    harness: { id: "omp", model: "A", smolModel: "C", modelRoles: { slow: "B" } },
    bindings: { "harness.model": "model", "harness.modelRoles.slow": "model", "harness.smolModel": "small", "sandbox.cpus": "cpus" },
    steps: [{ id: "impl", name: "Impl", kind: "prompt", prompt: "go" }],
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  const flow = v.flow;
  const bindings = flowBindings(flow);
  const [model, small, cpus] = flow.inputs;

  test("an input bound to fields with different values starts empty, so starting the run keeps each field's value", () => {
    expect(initialInputValue(model!, bindings)).toBe("");
    const run = materializeFlow(flow, { model: initialInputValue(model!, bindings), small: "", cpus: "" });
    if (!run.ok) throw new Error(run.errors.join("\n"));
    expect(run.flow.harness).toEqual({ id: "omp", model: "A", smolModel: "C", modelRoles: { slow: "B" } });
  });

  test("an input bound to one field shows that field's value; a default wins over it", () => {
    expect(initialInputValue(small!, bindings)).toBe("C");
    expect(initialInputValue(cpus!, bindings)).toBe("4");
  });
});
