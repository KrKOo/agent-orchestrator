import type { HarnessModels } from "@orch/protocol";
import { harnessRoleModels } from "./harness/omp";

/** What it takes to bring a run's sandbox in line with its current models. */
export interface ModelPlan {
  /** The config files hold other role models and must be rewritten (new harness processes read them). */
  files: boolean;
  /** Switch the live ACP session's main model (role `default`) to this id. */
  default?: string;
  /** The ACP process holds other role models than wanted: restart it (reloading its session) before its next turn. */
  restart: boolean;
}

function sameRoles(a: Map<string, string>, b: Map<string, string>, skip?: string): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  keys.delete(skip ?? "");
  for (const k of keys) if (a.get(k) !== b.get(k)) return false;
  return true;
}

/** Whether two model sets give every role the same model (`smolModel` unset equals it set to `model`). */
export function sameModels(a: HarnessModels, b: HarnessModels): boolean {
  return sameRoles(harnessRoleModels(a), harnessRoleModels(b));
}

/**
 * Tracks a run's harness models against what its sandbox has loaded: the config files (read by every new
 * harness process) and the running ACP process, whose role models are fixed at start except for its session's
 * main model, which ACP can switch live. Pure bookkeeping: the job performs what `plan` asks for and reports back.
 */
export class HarnessModelState {
  /** Models the run wants (the run's, then each `job.setModels`). */
  current: HarnessModels;
  /** Models the config files were last written with; null before the sandbox exists. */
  private files: HarnessModels | null = null;
  /** A rewrite failed part-way: the files may hold anything until the next one succeeds. */
  private filesStale = false;
  /** Role models the ACP process read at start, and its session's live main model; null without a process. */
  private process: { roles: Map<string, string>; default: string } | null = null;

  constructor(initial: HarnessModels) {
    this.current = initial;
  }

  /**
   * `offered`: whether the live ACP session can switch its main model to an id. `target` is the models one apply
   * works towards (read once, since `current` may move on while it awaits).
   */
  plan(offered: (id: string) => boolean, target: HarnessModels = this.current): ModelPlan {
    const want = harnessRoleModels(target);
    const files = this.files !== null && (this.filesStale || !sameRoles(harnessRoleModels(this.files), want));
    if (!this.process) return { files, restart: false };
    const otherRoles = !sameRoles(this.process.roles, want, "default");
    const defaultChanged = this.process.default !== target.model;
    const live = defaultChanged && offered(target.model);
    return { files, ...(live ? { default: target.model } : {}), restart: otherRoles || (defaultChanged && !live) };
  }

  /** The config files now hold `models`. */
  filesWritten(models: HarnessModels): void {
    this.files = models;
    this.filesStale = false;
  }

  /** Rewriting the config files failed; the next `plan` rewrites them whatever the models. */
  filesFailed(): void {
    this.filesStale = true;
  }

  /** The live ACP session switched its main model to `id`. */
  defaultSwitched(id: string): void {
    if (this.process) this.process.default = id;
  }

  /**
   * An ACP process (re)started: it read the role models of the config files as they are now. `sessionModel` is the
   * main model its session runs on (undefined when the harness does not report one: the files' main model).
   */
  processStarted(sessionModel: string | undefined): void {
    const loaded = this.files ?? this.current;
    this.process = { roles: harnessRoleModels(loaded), default: sessionModel ?? loaded.model };
  }
}
