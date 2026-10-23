import type { Context } from "hono";

export type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

/** Parses the request body as JSON; a malformed body yields a ready 400 response. */
export async function readJson(c: Context): Promise<JsonBody> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false, response: c.json({ error: "Request body must be valid JSON" }, 400) };
  }
}

/** Formats zod issues as `path: message` strings for `{errors}` bodies. */
export function issueMessages(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string[] {
  return issues.map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message));
}
