import type { AssignedRun, HarnessModels, ModelEntry } from "@orch/protocol";
import type { Mount, SandboxFile } from "../sandbox/types";

export interface HarnessAdapter {
  id: string;
  /**
   * Files written to the sandbox config dir (`/orch/config`) for the models `harness` (the run's, or a mid-run
   * switch's). `gw.url` is the sandbox-side gateway URL.
   */
  files(run: AssignedRun, harness: HarnessModels, gw: { url: string; providers: string[]; models: ModelEntry[] }): SandboxFile[];
  /**
   * Argv run in the sandbox after `files` were rewritten mid-run, for config the sandbox copied elsewhere at start
   * (null when the files are only read in place).
   */
  syncFilesArgv(): string[] | null;
  /**
   * Argv run in the sandbox before loading ACP session `sessionId` into a restarted harness process when the
   * harness does not list it; it makes the session findable. Null when there is nothing to prepare.
   */
  prepareLoadArgv(sessionId: string): string[] | null;
  env(gw: { token: string }): Record<string, string>;
  /** Extra mounts; `runDir` is the host per-run dir (`<dataDir>/runs/<runId>`). */
  mounts(run: AssignedRun, runDir: string): Mount[];
  acpArgv(run: AssignedRun): string[];
  /**
   * Argv for a headless one-shot slash-command run (`omp -p`); `/orch/config` files and env are already in place.
   * `resume` continues an earlier headless session (review-gate revisions) instead of starting a new one.
   */
  printArgv(resume?: string): string[];
}

/** Provider prefix of a `provider/model` id, or null for ids without `/`. */
export function modelProvider(model: string): string | null {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : null;
}
