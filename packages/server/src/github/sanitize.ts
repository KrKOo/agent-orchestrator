/** Default cap for inline review comments and check annotation messages. */
export const MAX_MESSAGE_CHARS = 2000;

/** Breaks `@user` / `@org/team` mentions so GitHub never notifies anyone. */
const MENTION_BREAK = "@\u200b";

/** `text.slice(0, n)` without leaving a dangling high surrogate. */
export function safeSlice(text: string, n: number): string {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/**
 * Render untrusted text as an inert fenced code block: mentions are neutralized and the
 * fence is one backtick longer than the longest backtick run inside (minimum 3), so the
 * text can never close the block early.
 */
export function sanitizeForMarkdown(text: string): string {
  const body = text.replaceAll("@", MENTION_BREAK);
  let longest = 0;
  for (const run of body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

/** Neutralize mentions, then truncate to at most `max` chars (ending with `…` when cut). */
export function neutralizeMentions(text: string, max = MAX_MESSAGE_CHARS): string {
  const out = text.replaceAll("@", MENTION_BREAK);
  if (out.length <= max) return out;
  return `${safeSlice(out, max - 1)}…`;
}
