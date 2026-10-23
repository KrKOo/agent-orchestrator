import type { Catalog, CatalogItem, CreateRunnerTokenResponse, FsListResult, RunnerRow } from "@orch/protocol";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import { schema, type Db } from "../db";
import type { AppDeps } from "../deps";
import { RpcError } from "../hub";
import { isOnline } from "../scheduler";
import { hashToken } from "../ws/runner";
import { issueMessages, readJson } from "./util";

const { runners } = schema;

export const FS_LIST_TIMEOUT_MS = 10_000;

const CreateRunnerBody = z.object({
  name: z.string().trim().min(1),
  labels: z.array(z.string().trim().min(1)).default([]),
});

/** Registers a runner with a fresh 32-byte token; only its sha256 is stored, so the token is returned once. */
export function registerRunner(
  db: Db,
  opts: { name: string; labels: string[]; ownerUserId: string | null },
): CreateRunnerTokenResponse {
  const token = randomBytes(32).toString("base64url");
  const runnerId = ulid().toLowerCase();
  db.insert(runners)
    .values({ id: runnerId, name: opts.name, tokenHash: hashToken(token), labels: opts.labels, ownerUserId: opts.ownerUserId })
    .run();
  return { runnerId, token };
}

function runnerRows(deps: AppDeps): RunnerRow[] {
  const now = Date.now();
  const names = new Map(deps.db.select({ id: runners.id, name: runners.name }).from(runners).all().map((r) => [r.id, r.name]));
  return deps.scheduler.runnerStates().map((s) => ({
    id: s.id,
    name: names.get(s.id) ?? s.id,
    labels: s.labels,
    ownerUserId: s.ownerUserId,
    capabilities: s.capabilities,
    lastSeenAt: s.lastSeenAt,
    online: isOnline(s, now),
    runningJobs: s.running,
  }));
}

/** Skills/commands advertised by online runners, merged by name and tagged with the runners offering them. */
export function buildCatalog(rows: RunnerRow[]): Catalog {
  const merge = (pick: (r: RunnerRow) => { name: string; description: string }[]): CatalogItem[] => {
    const byName = new Map<string, CatalogItem>();
    for (const r of rows) {
      if (!r.online) continue;
      for (const e of pick(r)) {
        const item = byName.get(e.name);
        if (item) item.runnerIds.push(r.id);
        else byName.set(e.name, { name: e.name, description: e.description, runnerIds: [r.id] });
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    skills: merge((r) => r.capabilities?.skills ?? []),
    commands: merge((r) => r.capabilities?.commands ?? []),
  };
}

export function runnerRoutes(deps: AppDeps): { runners: Hono; catalog: Hono } {
  const app = new Hono();

  app.get("/", (c) => c.json(runnerRows(deps)));

  app.post("/", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = CreateRunnerBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    const created = registerRunner(deps.db, { ...parsed.data, ownerUserId: c.get("user")?.id ?? null });
    return c.json(created, 201);
  });

  app.get("/:id/fs", async (c) => {
    const id = c.req.param("id");
    if (!deps.db.select({ id: runners.id }).from(runners).where(eq(runners.id, id)).get()) {
      return c.json({ error: "Runner not found" }, 404);
    }
    try {
      const result = await deps.hub.rpc<FsListResult>(id, "fs.list", { path: c.req.query("path") ?? "" }, FS_LIST_TIMEOUT_MS);
      return c.json(result);
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      if (err.kind === "timeout") return c.json({ error: err.message }, 504);
      if (err.kind === "offline") return c.json({ error: "Runner offline" }, 404);
      return c.json({ error: err.message }, 400);
    }
  });

  const catalog = new Hono();
  catalog.get("/", (c) => c.json(buildCatalog(runnerRows(deps))));

  return { runners: app, catalog };
}
