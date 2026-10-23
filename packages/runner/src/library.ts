import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CatalogEntry } from "@orch/protocol";

export interface SkillEntry {
  name: string;
  description: string;
  /** Absolute directory containing SKILL.md. */
  dir: string;
  /** SKILL.md without frontmatter. */
  body: string;
}

export interface CommandEntry {
  name: string;
  description: string;
  path: string;
  /** Command file without frontmatter. */
  body: string;
}

export interface ParsedMarkdown {
  attrs: Record<string, string>;
  body: string;
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Splits YAML frontmatter from a markdown document. Supports the flat subset used by skills/commands:
 * `key: value` (optionally quoted) and block scalars `key: |` / `key: >` with indented continuation lines.
 */
export function parseFrontmatter(text: string): ParsedMarkdown {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { attrs: {}, body: text };
  const attrs: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        block.push(lines[++i].trim());
      }
      attrs[key] = (value.startsWith(">") ? block.join(" ").replace(/\s+/g, " ") : block.join("\n")).trim();
    } else {
      attrs[key] = unquote(value);
    }
  }
  return { attrs, body: text.slice(m[0].length) };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

export class Library {
  private skills = new Map<string, SkillEntry>();
  private commands = new Map<string, CommandEntry>();
  private fingerprint = "";

  constructor(
    private readonly skillDirs: string[],
    private readonly commandDirs: string[],
  ) {}

  /** Rescans all directories; resolves true when the advertised catalog changed. */
  async scan(): Promise<boolean> {
    const skills = new Map<string, SkillEntry>();
    for (const root of this.skillDirs) {
      for (const entry of await listDir(root)) {
        if (entry.startsWith(".")) continue;
        const dir = join(root, entry);
        const file = Bun.file(join(dir, "SKILL.md"));
        if (!(await isDirectory(dir)) || !(await file.exists())) continue;
        const { attrs, body } = parseFrontmatter(await file.text());
        const name = attrs.name || entry;
        if (skills.has(name)) continue;
        skills.set(name, { name, description: attrs.description ?? "", dir, body });
      }
    }

    const commands = new Map<string, CommandEntry>();
    for (const root of this.commandDirs) {
      for (const entry of await listDir(root)) {
        if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
        const path = join(root, entry);
        const file = Bun.file(path);
        if (await isDirectory(path)) continue;
        const name = basename(entry, ".md");
        if (commands.has(name)) continue;
        const { attrs, body } = parseFrontmatter(await file.text());
        const description =
          attrs.description ??
          body
            .split("\n")
            .map((l) => l.trim())
            .find(Boolean) ??
          "";
        commands.set(name, { name, description, path, body });
      }
    }

    this.skills = skills;
    this.commands = commands;
    const fingerprint = JSON.stringify(this.catalog());
    const changed = fingerprint !== this.fingerprint;
    this.fingerprint = fingerprint;
    return changed;
  }

  getSkill(name: string): SkillEntry {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill;
  }

  getCommand(name: string): CommandEntry {
    const command = this.commands.get(name);
    if (!command) throw new Error(`Unknown command: ${name}`);
    return command;
  }

  catalog(): { skills: CatalogEntry[]; commands: CatalogEntry[] } {
    const toEntry = ({ name, description }: { name: string; description: string }): CatalogEntry => ({ name, description });
    return {
      skills: [...this.skills.values()].map(toEntry).sort((a, b) => a.name.localeCompare(b.name)),
      commands: [...this.commands.values()].map(toEntry).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}
