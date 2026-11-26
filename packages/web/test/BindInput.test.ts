import type { FlowDefinition, InputDef } from "@orch/protocol";
import { describe, expect, test } from "bun:test";
import { bindingsAfterInputChange } from "../src/components/BindInput";

function flow(inputs: InputDef[], key: string): FlowDefinition {
  return {
    name: "f",
    inputs,
    workspace: { kind: "local_path", path: "/repo", isolation: "worktree", baseRef: "HEAD", access: "rw" },
    sandbox: { provider: "docker", image: "img", network: { mode: "gateway_only", allow: [] }, cpus: 2, memoryMb: 4096 },
    harness: { id: "omp", model: "m" },
    approval: "auto",
    runnerLabels: [],
    trigger: { kind: "manual" },
    steps: [{ id: "impl", name: "Impl", kind: "prompt", prompt: "go", timeoutSec: 1800, freshSession: false, bindings: { timeoutSec: key } }],
    bindings: { "harness.model": key },
  };
}

const model = (key: string): InputDef => ({ key, label: "", type: "model", required: false });
const text = (key: string): InputDef => ({ key, label: "", type: "text", required: false });
const boundKeys = (def: FlowDefinition) => [def.bindings?.["harness.model"], def.steps[0]!.bindings?.timeoutSec];

describe("bindingsAfterInputChange", () => {
  test("a rename or removal of a uniquely keyed input carries or drops its flow and step bindings", () => {
    const def = flow([model("main"), text("note")], "main");
    expect(boundKeys(bindingsAfterInputChange(def, 0, "primary"))).toEqual(["primary", "primary"]);
    expect(boundKeys(bindingsAfterInputChange(def, 0, undefined))).toEqual([undefined, undefined]);
    expect(bindingsAfterInputChange(def, 1, "notes")).toBe(def);
  });

  test("bindings stay put when another input shares the old key (add → delete → add left a duplicate) or takes the new one", () => {
    // input_2 is bound; a later "Add input" repeated its key. Renaming or removing the new row must not touch them.
    const duplicate = flow([model("input_2"), text("input_2")], "input_2");
    expect(bindingsAfterInputChange(duplicate, 1, "input_3")).toBe(duplicate);
    expect(bindingsAfterInputChange(duplicate, 1, undefined)).toBe(duplicate);

    // Renaming the bound input onto another input's key would silently hand the bindings to that input.
    const collide = flow([model("main"), model("alt")], "main");
    expect(bindingsAfterInputChange(collide, 0, "alt")).toBe(collide);
  });
});
