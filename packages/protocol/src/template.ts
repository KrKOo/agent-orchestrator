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

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** All `{{ path }}` references in a template, in order of appearance (duplicates kept). */
export function templateRefs(tpl: string): string[] {
  return Array.from(tpl.matchAll(TEMPLATE_RE), (m) => m[1]!);
}

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
