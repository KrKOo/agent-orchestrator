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

  files(run, harness, gw) {
    const roles = harnessRoleModels(harness);
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

  syncFilesArgv() {
    // The sandbox entrypoint copies models.yml into omp's agent dir at start; omp reads it only from there.
    return ["sh", "-c", 'cp /orch/config/models.yml "$HOME/.omp/agent/models.yml"'];
  },

  prepareLoadArgv(sessionId) {
    // Verified on omp 18.22.2: `session/load` (and `session/list`) look sessions up only in omp's default
    // per-cwd dir (`~/.omp/agent/sessions/<encoded cwd>/`), ignoring `--session-dir`. The runner calls
    // `session/list {cwd}` first, which creates that dir; linking the session file there makes it loadable.
    // omp keeps appending through the link, and the session's artifact dir (subagent sessions) is linked too,
    // so everything still lands in /orch/sessions, where the subagent tail reads it.
    const script = [
      "set -e",
      `f=$(ls ${OMP_SESSIONS_DIR}/*_"$1".jsonl 2>/dev/null | head -n 1)`,
      '[ -n "$f" ] || { echo "no omp session file for $1" >&2; exit 1; }',
      'b=$(basename "$f" .jsonl)',
      `mkdir -p "${OMP_SESSIONS_DIR}/$b"`,
      "linked=",
      'for d in "$HOME"/.omp/agent/sessions/*/; do',
      '  [ -d "$d" ] || continue',
      '  ln -sfn "$f" "$d$b.jsonl"',
      `  ln -sfn "${OMP_SESSIONS_DIR}/$b" "$d$b"`,
      "  linked=1",
      "done",
      '[ -n "$linked" ] || { echo "omp session dir not found under $HOME/.omp/agent/sessions" >&2; exit 1; }',
    ].join("\n");
    // The id is a positional argument, never part of the script text.
    return ["sh", "-c", script, "sh", sessionId];
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

  printArgv(resume) {
    // Headless one-shot: slash commands run their documented headless path (no mode chooser).
    // `--mode json` streams NDJSON progress events; the runner translates them into `acp.update`s.
    const argv = ["omp", "-p", "--mode", "json", "--config", "/orch/config/omp-config.yml", "--session-dir", OMP_SESSIONS_DIR];
    return resume === undefined ? argv : [...argv, "--resume", resume];
  },
};

export const harnesses: Record<string, HarnessAdapter> = { omp: ompAdapter };
