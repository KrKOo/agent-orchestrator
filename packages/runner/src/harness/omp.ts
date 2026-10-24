import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelEntry } from "@orch/protocol";
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

/** omp API dialect per known provider prefix; unknown providers speak OpenAI-compatible chat (e.g. litellm). */
const PROVIDER_APIS: Record<string, string> = {
  anthropic: "anthropic-messages",
  openai: "openai-completions",
  "azure-openai": "azure-openai",
  google: "google-generative-ai",
};

/**
 * Renders `models.yml`: every gateway provider with an explicit model list. omp silently disables
 * custom providers whose `models.yml` fails validation, and unknown providers need an `api` dialect
 * plus explicit `models:` entries (discovery alone does not register them) — otherwise e.g.
 * `modelRoles.default: litellm/glm-5.3` cannot resolve and omp falls back to its catalog default.
 */
export function modelsYml(gw: { url: string; providers: string[]; models: ModelEntry[] }, roleModels: string[]): string {
  const byProvider = new Map<string, { id: string; name: string }[]>();
  const add = (id: string, name?: string) => {
    const i = id.indexOf("/");
    if (i <= 0) return;
    const provider = id.slice(0, i);
    const entry = { id: id.slice(i + 1), name: name && name !== id ? name : id.slice(i + 1) };
    const list = byProvider.get(provider);
    if (list) {
      if (!list.some((e) => e.id === entry.id)) list.push(entry);
    } else {
      byProvider.set(provider, [entry]);
    }
  };
  for (const m of gw.models) add(m.id, m.name);
  // The gateway only advertises credentials it holds; the flow's own role models must always be routable.
  for (const id of roleModels) add(id);
  const providers = [...new Set([...gw.providers, ...byProvider.keys()])].sort();
  const lines = ["providers:"];
  for (const p of providers) {
    lines.push(`  ${yaml(p)}:`, `    baseUrl: ${yaml(gw.url)}`, "    apiKey: ORCH_GATEWAY_TOKEN", "    transport: pi-native");
    // Every provider must declare an api dialect; unknown ones default to OpenAI-compatible chat.
    lines.push(`    api: ${yaml(PROVIDER_APIS[p] ?? "openai-completions")}`);
    const list = byProvider.get(p) ?? [];
    if (list.length) {
      lines.push("    models:");
      for (const m of list) lines.push(`      - id: ${yaml(m.id)}`, `        name: ${yaml(m.name)}`);
    }
  }
  return lines.join("\n");
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
    const modelsYmlText = modelsYml({ url: gw.url, providers: [...providers], models: gw.models }, [...roles.values()]);
    const configYml = [
      "modelRoles:",
      ...[...roles.entries()].map(([role, model]) => `  ${role}: ${yaml(model)}`),
      "tools:",
      `  approvalMode: ${run.definition.approval === "ask" ? "always-ask" : "yolo"}`,
      "async:",
      "  enabled: false",
    ].join("\n");
    return [
      { path: "models.yml", content: `${modelsYmlText}\n` },
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
