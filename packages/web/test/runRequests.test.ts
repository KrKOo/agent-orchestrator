import { describe, expect, test } from "bun:test";
import { initialRunViewState, type ElicitationView, type InterventionView, type PermissionView } from "../src/runState";
import { pendingRequest } from "../src/runRequests";

const permission = (id: string, resolved = false): PermissionView => ({
  requestId: id,
  toolCall: {},
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  resolved,
});
const elicitation = (id: string, resolved = false): ElicitationView => ({
  requestId: id,
  message: "pick one",
  requestedSchema: {},
  resolved,
});
const intervention = (id: string, resolved = false): InterventionView => ({
  requestId: id,
  message: "need input",
  sessions: [],
  resolved,
});

describe("pendingRequest", () => {
  test("returns undefined when nothing is pending", () => {
    expect(pendingRequest(initialRunViewState, new Set())).toBeUndefined();
    const state = { ...initialRunViewState, permissions: [permission("p1", true)] };
    expect(pendingRequest(state, new Set())).toBeUndefined();
  });

  test("skips requests already answered from this browser", () => {
    const state = { ...initialRunViewState, permissions: [permission("p1")] };
    expect(pendingRequest(state, new Set(["p1"]))).toBeUndefined();
  });

  test("prefers permission over elicitation over intervention", () => {
    const all = {
      ...initialRunViewState,
      permissions: [permission("p1")],
      elicitations: [elicitation("e1")],
      interventions: [intervention("i1")],
    };
    expect(pendingRequest(all, new Set())?.kind).toBe("permission");
    expect(pendingRequest({ ...all, permissions: [] }, new Set())?.kind).toBe("elicitation");
    expect(pendingRequest({ ...all, permissions: [], elicitations: [] }, new Set())?.kind).toBe("intervention");
  });

  test("after the first is answered, the next kind surfaces", () => {
    const state = {
      ...initialRunViewState,
      permissions: [permission("p1"), permission("p2")],
      elicitations: [elicitation("e1")],
    };
    expect(pendingRequest(state, new Set())?.request.requestId).toBe("p1");
    expect(pendingRequest(state, new Set(["p1"]))?.request.requestId).toBe("p2");
    expect(pendingRequest(state, new Set(["p1", "p2"]))?.request.requestId).toBe("e1");
  });
});
