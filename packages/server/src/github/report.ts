import type { Finding } from "@orch/protocol";
import { neutralizeMentions, safeSlice, sanitizeForMarkdown } from "./sanitize";

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled";
type TerminalStatus = "succeeded" | "failed" | "cancelled";

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  message: string;
  title?: string;
}

export interface SummaryStep {
  id: string;
  name: string;
  status: string;
  output: string | null;
}

/** Check run `output.summary` limit is 65 535 chars; the plan caps ours at 60 000. */
export const MAX_SUMMARY_CHARS = 60_000;
const MAX_ERROR_TITLE_CHARS = 200;
const TRUNCATED_MARK = "\n… (truncated)";
const SEP = "\n\n";

const ANNOTATION_LEVEL: Record<Finding["severity"], CheckAnnotation["annotation_level"]> = {
  error: "failure",
  warning: "warning",
  info: "notice",
};

/** One markdown list line for a finding; message and path are mention-neutralized. */
function formatFindingLine(f: Finding): string {
  const message = neutralizeMentions(f.message).replace(/\s*\n\s*/g, " ");
  const path = neutralizeMentions(f.file, 500).replaceAll("`", "'");
  return `- \`${path}:${f.line}\` ${f.severity}: ${message}`;
}

/**
 * Markdown list of findings fitting within `maxChars`; overflow collapses into a final
 * `- … and N more` line.
 */
export function formatFindingList(findings: Finding[], maxChars: number): string {
  const lines = findings.map(formatFindingLine);
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const candidate = out === "" ? lines[i]! : `${out}\n${lines[i]}`;
    const left = lines.length - i - 1;
    const reserve = left > 0 ? `\n- … and ${left} more`.length : 0;
    if (candidate.length + reserve > maxChars) {
      const more = `- … and ${lines.length - i} more`;
      return out === "" ? more : `${out}\n${more}`;
    }
    out = candidate;
  }
  return out;
}

export function checkConclusion(status: TerminalStatus, findings: Finding[]): CheckConclusion {
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failure";
  if (findings.some((f) => f.severity === "error")) return "failure";
  if (findings.some((f) => f.severity === "warning")) return "neutral";
  return "success";
}

export function checkTitle(status: TerminalStatus, error: string | null, done: number, total: number): string {
  if (status === "failed") {
    const reason = error ?? "unknown error";
    const short = reason.length > MAX_ERROR_TITLE_CHARS ? `${safeSlice(reason, MAX_ERROR_TITLE_CHARS - 1)}…` : reason;
    return `Run failed: ${short}`;
  }
  if (status === "cancelled") return "Cancelled";
  return `${done}/${total} steps`;
}

/** Fenced block for the first `n` chars of `output`, marked as truncated when cut. */
function renderOutput(output: string, n: number): string {
  return n >= output.length ? sanitizeForMarkdown(output) : sanitizeForMarkdown(safeSlice(output, n) + TRUNCATED_MARK);
}

/** Longest fenced rendering of `output` whose length is ≤ `budget`, or null if none fits. */
function fitOutput(output: string, budget: number): string | null {
  const full = sanitizeForMarkdown(output);
  if (full.length <= budget) return full;
  // Rendered length is monotone in the prefix length: binary search the largest fit.
  let lo = 0;
  let hi = output.length - 1;
  if (renderOutput(output, lo).length > budget) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (renderOutput(output, mid).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return renderOutput(output, lo);
}

/** Water-filling split of `budget` across `needs`: small needs are met fully, large ones share the rest equally. */
function allocate(needs: number[], budget: number): number[] {
  const alloc = needs.map(() => 0);
  const order = needs.map((_, i) => i).sort((a, b) => needs[a]! - needs[b]!);
  let remaining = budget;
  order.forEach((idx, k) => {
    const share = Math.floor(remaining / (order.length - k));
    alloc[idx] = Math.min(needs[idx]!, share);
    remaining -= alloc[idx]!;
  });
  return alloc;
}

/**
 * Check run summary: one section per step with its sanitized output, then findings that
 * could not be annotated. Step outputs are truncated (fairly, each fence kept closed) so
 * the whole summary stays within {@link MAX_SUMMARY_CHARS}.
 */
export function checkSummary(steps: SummaryStep[], extraFindings: Finding[] = []): string {
  const headers = steps.map((s) => `### ${neutralizeMentions(s.name, 200)} — ${neutralizeMentions(s.status, 50)}`);
  const headersLen = headers.reduce((sum, h) => sum + h.length, 0) + SEP.length * Math.max(0, headers.length - 1);
  // Each present output costs SEP + its fenced block.
  const needs = steps.map((s) => (s.output ? SEP.length + sanitizeForMarkdown(s.output).length : 0));
  const outputsNeed = needs.reduce((a, b) => a + b, 0);

  const available = Math.max(0, MAX_SUMMARY_CHARS - headersLen);
  let extras = "";
  if (extraFindings.length > 0) {
    const heading = `${headers.length > 0 ? SEP : ""}### Findings outside the diff\n\n`;
    // Outputs keep at least half of the space when they need it.
    const extrasBudget = available - Math.min(outputsNeed, Math.floor(available / 2));
    if (extrasBudget > heading.length) extras = heading + formatFindingList(extraFindings, extrasBudget - heading.length);
  }

  const alloc = allocate(needs, available - extras.length);
  const sections = steps.map((s, i) => {
    if (!s.output) return headers[i]!;
    const block = fitOutput(s.output, alloc[i]! - SEP.length);
    return block === null ? headers[i]! : `${headers[i]}${SEP}${block}`;
  });
  return sections.join(SEP) + extras;
}

/**
 * Annotations for findings on PR-changed files; everything else is returned in `outside`
 * so the caller can list it in the summary.
 */
export function buildAnnotations(
  findings: Finding[],
  changedFiles: Set<string>,
): { annotations: CheckAnnotation[]; outside: Finding[] } {
  const annotations: CheckAnnotation[] = [];
  const outside: Finding[] = [];
  for (const f of findings) {
    if (!changedFiles.has(f.file)) {
      outside.push(f);
      continue;
    }
    const annotation: CheckAnnotation = {
      path: f.file,
      start_line: f.line,
      end_line: f.endLine ?? f.line,
      annotation_level: ANNOTATION_LEVEL[f.severity],
      message: neutralizeMentions(f.message),
    };
    if (f.ruleId) annotation.title = f.ruleId;
    annotations.push(annotation);
  }
  return { annotations, outside };
}
