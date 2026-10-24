import type { AssignedRun, ModelEntry } from "@orch/protocol";
import type { Mount, SandboxFile } from "../sandbox/types";

export interface HarnessAdapter {
  id: string;
  /** Files written to the sandbox config dir (`/orch/config`). `gw.url` is the sandbox-side gateway URL. */
  files(run: AssignedRun, gw: { url: string; providers: string[]; models: ModelEntry[] }): SandboxFile[];
  env(gw: { token: string }): Record<string, string>;
  /** Extra mounts; `runDir` is the host per-run dir (`<dataDir>/runs/<runId>`). */
  mounts(run: AssignedRun, runDir: string): Mount[];
  acpArgv(run: AssignedRun): string[];
}

/** Provider prefix of a `provider/model` id, or null for ids without `/`. */
export function modelProvider(model: string): string | null {
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : null;
}
