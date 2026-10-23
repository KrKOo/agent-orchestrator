import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RunEventOf, SubagentBlock } from "@orch/protocol";

export type SubagentEvent =
  | { type: "subagent.started"; payload: RunEventOf<"subagent.started">["payload"] }
  | { type: "subagent.message"; payload: RunEventOf<"subagent.message">["payload"] };

const POLL_MS = 500;
const TOOL_RESULT_MAX = 4000;
const ROLES = ["user", "assistant", "toolResult"] as const;
type Role = (typeof ROLES)[number];
const isRole = (v: unknown): v is Role => ROLES.some((r) => r === v);

interface FileState {
  offset: number;
  partial: Buffer;
  parseErrorLogged: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function blockText(b: Json): string {
  if (typeof b.text === "string") return b.text;
  return JSON.stringify(b);
}

function mapBlocks(role: Role, content: unknown): SubagentBlock[] {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const out: SubagentBlock[] = [];
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (role === "toolResult") {
      out.push({ type: "toolResult", text: blockText(b).slice(0, TOOL_RESULT_MAX) });
    } else if (b.type === "text") {
      out.push({ type: "text", text: str(b.text) });
    } else if (b.type === "thinking") {
      out.push({ type: "thinking", text: str(b.thinking) || str(b.text) });
    } else if (b.type === "toolCall") {
      out.push({
        type: "toolCall",
        id: str(b.id),
        name: str(b.name),
        ...(typeof b.intent === "string" ? { intent: b.intent } : {}),
        arguments: b.arguments,
      });
    }
  }
  return out;
}

/** Maps one session-file entry to a subagent event, or null for entries we ignore. */
export function mapEntry(agentId: string, e: unknown): SubagentEvent | null {
  if (!isObj(e)) return null;
  if (e.type === "session_init") {
    return {
      type: "subagent.started",
      payload: { agentId, agent: str(e.agent), task: str(e.task), model: typeof e.resolvedModel === "string" ? e.resolvedModel : null },
    };
  }
  if (e.type === "message" && isObj(e.message)) {
    const role = e.message.role;
    if (!isRole(role)) return null;
    return { type: "subagent.message", payload: { agentId, role, blocks: mapBlocks(role, e.message.content) } };
  }
  return null;
}

async function listJsonl(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => join(e.parentPath, e.name));
}

/**
 * Tails omp subagent transcripts under a session dir. A file is a subagent transcript when its parent
 * directory's name equals the stem of a sibling `.jsonl` (`<dir>/<X>.jsonl` + `<dir>/<X>/<AgentId>.jsonl`).
 * Polls instead of `fs.watch`, which is unreliable on Docker Desktop bind mounts.
 */
export class SubagentTail {
  private readonly files = new Map<string, FileState>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | null = null;

  constructor(
    private readonly sessionsDir: string,
    private readonly emit: (event: SubagentEvent) => void,
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.poll(), POLL_MS);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.polling;
  }

  /** One poll pass; concurrent calls share the in-flight pass. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    let paths: string[];
    try {
      paths = await listJsonl(this.sessionsDir);
    } catch (err) {
      console.error(`[subagent-tail] list ${this.sessionsDir}: ${err}`);
      return;
    }
    const all = new Set(paths);
    for (const path of paths.sort()) {
      const parent = dirname(path);
      if (!all.has(`${parent}.jsonl`)) continue;
      try {
        await this.readNew(path, basename(path, ".jsonl"));
      } catch (err) {
        console.error(`[subagent-tail] read ${path}: ${err}`);
      }
    }
  }

  private async readNew(path: string, agentId: string): Promise<void> {
    let state = this.files.get(path);
    if (!state) {
      state = { offset: 0, partial: Buffer.alloc(0), parseErrorLogged: false };
      this.files.set(path, state);
    }
    const fh = await open(path, "r");
    let chunk: Buffer;
    try {
      const { size } = await fh.stat();
      if (size <= state.offset) return;
      chunk = Buffer.alloc(size - state.offset);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, state.offset);
      chunk = chunk.subarray(0, bytesRead);
      state.offset += bytesRead;
    } finally {
      await fh.close();
    }
    let data = state.partial.length ? Buffer.concat([state.partial, chunk]) : chunk;
    let nl: number;
    while ((nl = data.indexOf(0x0a)) !== -1) {
      const line = data.subarray(0, nl).toString("utf8").trim();
      data = data.subarray(nl + 1);
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        if (!state.parseErrorLogged) console.error(`[subagent-tail] unparsable line in ${path}`);
        state.parseErrorLogged = true;
        continue;
      }
      const ev = mapEntry(agentId, entry);
      if (ev) this.emit(ev);
    }
    state.partial = Buffer.from(data);
  }
}
