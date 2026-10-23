import { validateFlow } from "@orch/protocol";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import { flowRow } from "../rows";
import { readJson } from "./util";

const { flows } = schema;

export function flowRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  app.get("/", (c) => c.json(db.select().from(flows).orderBy(desc(flows.updatedAt)).all().map(flowRow)));

  app.post("/", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const v = validateFlow(body.value);
    if (!v.ok) return c.json({ errors: v.errors }, 400);
    const now = Date.now();
    const row = db
      .insert(flows)
      .values({ id: ulid(), name: v.flow.name, definition: v.flow, version: 1, createdAt: now, updatedAt: now })
      .returning()
      .get();
    return c.json(flowRow(row), 201);
  });

  app.get("/:id", (c) => {
    const row = db.select().from(flows).where(eq(flows.id, c.req.param("id"))).get();
    return row ? c.json(flowRow(row)) : c.json({ error: "Flow not found" }, 404);
  });

  app.put("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = db.select().from(flows).where(eq(flows.id, id)).get();
    if (!existing) return c.json({ error: "Flow not found" }, 404);
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const v = validateFlow(body.value);
    if (!v.ok) return c.json({ errors: v.errors }, 400);
    const row = db
      .update(flows)
      .set({ name: v.flow.name, definition: v.flow, version: existing.version + 1, updatedAt: Date.now() })
      .where(eq(flows.id, id))
      .returning()
      .get();
    return c.json(flowRow(row));
  });

  app.delete("/:id", (c) => {
    const deleted = db.delete(flows).where(eq(flows.id, c.req.param("id"))).returning({ id: flows.id }).all();
    return deleted.length ? c.body(null, 204) : c.json({ error: "Flow not found" }, 404);
  });

  return app;
}
