import { describe, expect, test } from "bun:test";
import { HarnessModelState } from "../src/model-switch";

const A = "anthropic/a";
const B = "anthropic/b";
const offered = (id: string) => id.startsWith("anthropic/");

/** A state whose config files and ACP process both hold `{ model: A, smolModel: A }`. */
function started(): HarnessModelState {
  const state = new HarnessModelState({ model: A, smolModel: A });
  state.filesWritten(state.current);
  state.processStarted(A);
  return state;
}

describe("HarnessModelState", () => {
  test("unchanged models need nothing", () => {
    const state = started();
    state.current = { model: A, smolModel: A };
    expect(state.plan(offered)).toEqual({ files: false, restart: false });
  });

  test("a main model the session offers switches live; once switched, nothing is left", () => {
    const state = started();
    state.current = { model: B, smolModel: A };
    expect(state.plan(offered)).toEqual({ files: true, default: B, restart: false });
    state.filesWritten(state.current);
    state.defaultSwitched(B);
    expect(state.plan(offered)).toEqual({ files: false, restart: false });
  });

  test("any other role restarts the process, until it started from the new files", () => {
    const state = started();
    state.current = { model: A, smolModel: A, modelRoles: { task: B } };
    expect(state.plan(offered)).toEqual({ files: true, restart: true });
    state.filesWritten(state.current);
    expect(state.plan(offered)).toEqual({ files: false, restart: true });
    state.processStarted(A);
    expect(state.plan(offered)).toEqual({ files: false, restart: false });
  });

  test("an unset small model follows the main one, so switching the main model changes smol too", () => {
    const state = new HarnessModelState({ model: A });
    state.filesWritten(state.current);
    state.processStarted(undefined);
    state.current = { model: B };
    expect(state.plan(offered)).toEqual({ files: true, default: B, restart: true });
  });

  test("a plan works towards its own target, whatever `current` became meanwhile", () => {
    const state = started();
    const target = { model: A, smolModel: A, modelRoles: { task: B } };
    state.current = target;
    state.filesWritten(target);
    state.current = { model: A, smolModel: A, modelRoles: { task: "anthropic/c" } };
    expect(state.plan(offered, target)).toEqual({ files: false, restart: true });
    expect(state.plan(offered)).toEqual({ files: true, restart: true });
  });

  test("a main model the session does not offer restarts the process", () => {
    const state = started();
    state.current = { model: "custom/new", smolModel: A };
    expect(state.plan(offered)).toEqual({ files: true, restart: true });
  });

  test("switching back before the restart cancels it", () => {
    const state = started();
    state.current = { model: A, smolModel: B };
    state.filesWritten(state.current);
    expect(state.plan(offered).restart).toBe(true);
    state.current = { model: A, smolModel: A };
    expect(state.plan(offered)).toEqual({ files: true, restart: false });
  });

  test("before the sandbox and the process exist, a switch only changes what they will start with", () => {
    const state = new HarnessModelState({ model: A });
    state.current = { model: B, modelRoles: { plan: B } };
    expect(state.plan(offered)).toEqual({ files: false, restart: false });
  });

  test("after a failed rewrite the files are rewritten even when the models went back", () => {
    const state = started();
    state.filesFailed();
    expect(state.plan(offered)).toEqual({ files: true, restart: false });
    state.filesWritten(state.current);
    expect(state.plan(offered)).toEqual({ files: false, restart: false });
  });
});
