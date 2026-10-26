export interface TemplateContext {
  inputs: Record<string, unknown>;
  steps: Record<string, { output: string; structured?: unknown }>;
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** All `{{ path }}` references in a template, in order of appearance (duplicates kept). */
export function templateRefs(tpl: string): string[] {
  return Array.from(tpl.matchAll(TEMPLATE_RE), (m) => m[1]!);
}

/** Matches one `{{ path }}` reference; capture 1 is the trimmed path between the braces. */
export const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function lookup(ctx: TemplateContext, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) {
      throw new TemplateError(`Unknown template variable: ${path}`);
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === undefined) throw new TemplateError(`Unknown template variable: ${path}`);
  return cur;
}

export function renderTemplate(tpl: string, ctx: TemplateContext): string {
  return tpl.replace(TEMPLATE_RE, (_m, path: string) => {
    const value = lookup(ctx, path);
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Renders a `shell` step's command so its template values reach bash as data, never code: every
 * `{{…}}` is rewritten to `${ORCH_REF_n}` and each value is passed as an exported environment
 * variable in the `bash -c` prefix (single-quoted so no character is interpreted by bash). Bash
 * never re-parses expansion results, so `$(…)`/backticks in the values stay inert. Values for
 * earlier references are reused (deduplicated) to keep the script small.
 */
export function renderShellCommand(tpl: string, ctx: TemplateContext): string {
  const exports: string[] = [];
  const names = new Map<string, string>();
  const script = tpl.replace(TEMPLATE_RE, (_m, path: string) => {
    let name = names.get(path);
    if (name === undefined) {
      const resolved = lookup(ctx, path);
      const value = typeof resolved === "string" ? resolved : resolved !== null && typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
      name = `ORCH_REF_${names.size}`;
      names.set(path, name);
      // `'\''` closes the single quote, an escaped literal quote, and reopens: safe inside single quotes.
      exports.push(`export ${name}='${value.replaceAll("'", `'\\''`)}'`);
    }
    return `\${${name}}`;
  });
  return exports.length ? `${exports.join("\n")}\n${script}` : script;
}
