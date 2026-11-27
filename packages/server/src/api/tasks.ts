// Tasks REST (`/api/tasks`): list/create tasks, read/update one, the chat log and its runs.
// Validation happens in `tasks.ts` (`TaskService`), so the routes stay thin.
import { CreateTaskBody, PostTaskMessageBody, UpdateTaskBody } from "@orch/protocol";
import { Hono } from "hono";
import type { AppDeps } from "../deps";
import { TaskError } from "../tasks";
import { issueMessages, readJson } from "./util";

export function taskRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  /** All tasks, newest `updatedAt` first; `?archived=1` includes archived ones. */
  app.get("/", (c) => c.json(deps.tasks.list(c.req.query("archived") === "1")));

  app.post("/", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = CreateTaskBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    try {
      return c.json(deps.tasks.create(parsed.data, c.get("user")?.id ?? null), 201);
    } catch (err) {
      if (!(err instanceof TaskError)) throw err;
      return c.json({ error: err.message }, 400);
    }
  });

  app.get("/:id", (c) => {
    const detail = deps.tasks.detail(c.req.param("id")!);
    return detail ? c.json(detail) : c.json({ error: "Task not found" }, 404);
  });

  app.patch("/:id", async (c) => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = UpdateTaskBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    try {
      const task = deps.tasks.update(c.req.param("id")!, parsed.data);
      return task ? c.json(task) : c.json({ error: "Task not found" }, 404);
    } catch (err) {
      if (!(err instanceof TaskError)) throw err;
      return c.json({ error: err.message }, 400);
    }
  });

  /** The chat log with `seq > afterSeq`, ascending. */
  app.get("/:id/messages", (c) => {
    const id = c.req.param("id")!;
    if (!deps.tasks.get(id)) return c.json({ error: "Task not found" }, 404);
    const afterSeq = Math.max(0, Number(c.req.query("afterSeq") ?? 0) || 0);
    return c.json(deps.tasks.messages(id, afterSeq));
  });

  app.post("/:id/messages", async (c) => {
    const id = c.req.param("id")!;
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = PostTaskMessageBody.safeParse(body.value);
    if (!parsed.success) return c.json({ errors: issueMessages(parsed.error.issues) }, 400);
    try {
      return c.json(deps.tasks.postMessage(id, parsed.data), 201);
    } catch (err) {
      if (!(err instanceof TaskError)) throw err;
      if (err.code === "not_found") return c.json({ error: err.message }, 404);
      return c.json({ error: err.message }, err.code === "archived" ? 409 : 400);
    }
  });

  app.get("/:id/runs", (c) => {
    const id = c.req.param("id")!;
    if (!deps.tasks.get(id)) return c.json({ error: "Task not found" }, 404);
    return c.json(deps.tasks.taskRuns(id));
  });

  return app;
}
