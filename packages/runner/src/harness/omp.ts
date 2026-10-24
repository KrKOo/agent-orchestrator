import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Mount } from "../sandbox/types";
import { type HarnessAdapter, modelProvider } from "./types";

/** Sandbox-side directory holding omp session files (bind-mounted from `<runDir>/sessions`). */
export const OMP_SESSIONS_DIR = "/orch/sessions";

const yaml = (s: string) => JSON.stringify(s);

/** All role → model mappings of a harness spec, with `smol` falling back to `model`. */
export function harnessRoleModels(spec: { model: string; smolModel?: string; modelRoles?: Record<string, string> }): Map<string, string> {
  const roles = new Map<string, string>(Object.entries(spec.modelRoles ?? {}));
  roles.set("default", spec.model);
  roles.set("smol", spec.smolModel ?? spec.modelRoles?.smol ?? spec.model);
  return roles;
}

export const ompAdapter: HarnessAdapter = {
  id: "omp",

  files(run, gw) {
    const roles = harnessRoleModels(run.definition.harness);
    const providers = new Set(gw.providers);
    for (const m of roles.values()) {
      const p = modelProvider(m);
      if (p) providers.add(p);
    }
    const modelsYml = [
      "providers:",
      ...[...providers].sort().flatMap((p) => [
        `  ${yaml(p)}:`,
        `    baseUrl: ${yaml(gw.url)}`,
        "    apiKey: ORCH_GATEWAY_TOKEN",
        "    transport: pi-native",
      ]),
    ].join("\n");
    const configYml = [
      "modelRoles:",
      ...[...roles.entries()].map(([role, model]) => `  ${role}: ${yaml(model)}`),
      "tools:",
      `  approvalMode: ${run.definition.approval === "ask" ? "always-ask" : "yolo"}`,
      "async:",
      "  enabled: false",
    ].join("\n");
    return [
      { path: "models.yml", content: `${modelsYml}\n` },
      { path: "omp-config.yml", content: `${configYml}\n` },
    ];
  },

  env(gw) {
    return { ORCH_GATEWAY_TOKEN: gw.token };
  },

  mounts(run, runDir) {
    const mounts: Mount[] = [{ hostPath: join(runDir, "sessions"), containerPath: OMP_SESSIONS_DIR, readonly: false }];
    if (run.trust === "owner") {
      for (const d of ["agents", "skills"]) {
        const host = join(homedir(), ".omp", "agent", d);
        if (existsSync(host)) mounts.push({ hostPath: host, containerPath: `/orch/omp-user/${d}`, readonly: true });
      }
    }
    return mounts;
  },

  acpArgv() {
    // Verified on omp 18.10.3: flags after `acp` are honoured (`--config` overlay, `--session-dir`).
    return ["omp", "acp", "--config", "/orch/config/omp-config.yml", "--session-dir", OMP_SESSIONS_DIR];
  },
};

export const harnesses: Record<string, HarnessAdapter> = { omp: ompAdapter };
