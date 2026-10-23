import type { Finding } from "@orch/protocol";
import { neutralizeMentions } from "./sanitize";

/** Entry of `GET /repos/{o}/{r}/pulls/{n}/files`; `patch` is absent for binary or huge diffs. */
export interface ChangedFile {
  filename: string;
  patch?: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export const MAX_INLINE_COMMENTS = 50;
/** GitHub caps review bodies at 65 536 chars; stay well below. */
const MAX_REVIEW_BODY_CHARS = 60_000;

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** RIGHT-side line numbers (added + context lines) a review comment may target. */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (patch === undefined) return lines;
  let next: number | null = null;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === null) continue;
    switch (line[0]) {
      case "+":
      case " ":
        lines.add(next++);
        break;
      // "-" (deleted, LEFT side only) and "\" (`\ No newline at end of file`) don't advance.
    }
  }
  return lines;
}

/** One markdown list line for a finding; message and path are mention-neutralized. */
export function formatFindingLine(f: Finding): string {
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

/**
 * Split findings into inline comments (on commentable RIGHT-side lines, at most 50, input
 * order) and a review body listing the rest.
 */
export function buildReview(
  findings: Finding[],
  files: ChangedFile[],
): { comments: ReviewComment[]; body: string } {
  const commentable = new Map<string, Set<number>>();
  for (const file of files) commentable.set(file.filename, commentableLines(file.patch));

  const comments: ReviewComment[] = [];
  const rest: Finding[] = [];
  for (const f of findings) {
    if (comments.length < MAX_INLINE_COMMENTS && commentable.get(f.file)?.has(f.line)) {
      const rule = f.ruleId ? ` (${neutralizeMentions(f.ruleId, 100)})` : "";
      const body = `**${f.severity}**${rule}: ${neutralizeMentions(f.message)}`;
      comments.push({ path: f.file, line: f.line, side: "RIGHT", body });
    } else {
      rest.push(f);
    }
  }

  const n = findings.length;
  let body = `Orchestrator found ${n} finding${n === 1 ? "" : "s"}.`;
  if (rest.length > 0) {
    const heading = `\n\n${rest.length} not attached to changed lines:\n\n`;
    body += heading + formatFindingList(rest, MAX_REVIEW_BODY_CHARS - body.length - heading.length);
  }
  return { comments, body };
}
