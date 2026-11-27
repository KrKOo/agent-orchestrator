// Task stream `WS /api/tasks/:id/stream?afterSeq=N` (issue #34): registered before the REST sub-app
// so `/api/tasks/:id/...` routes do not shadow it. Frames are JSON arrays of `TaskStreamItem`.
// Backlog first (messages after `afterSeq`, the task row, every task run), then live items.
import type { TaskStreamItem } from "@orch/protocol";
import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { originAllowed } from "./browser";
import { sessionUser } from "../auth/session";
import type { AppDeps } from "../deps";

/** The task stream uses the same frames as the REST-shaped `TaskStreamItem` union. */
type Item = TaskStreamItem;

export function registerTaskStream(app: Hono, deps: AppDeps): void {
  app.get(
    "/api/tasks/:id/stream",
    upgradeWebSocket((c) => {
      const taskId = c.req.param("id")!;
      const afterSeq = Math.max(0, Number(c.req.query("afterSeq") ?? 0) || 0);
      const allowed = originAllowed(deps, c.req.header("origin"));
      const authorized = deps.config.auth.mode === "none" || sessionUser(deps, c) !== null;
      let unsubscribe: (() => void) | null = null;
      return {
        onOpen(_evt, ws) {
          if (!allowed) {
            ws.close(4403, "origin not allowed");
            return;
          }
          if (!authorized) {
            ws.close(4401, "unauthorized");
            return;
          }
          const task = deps.tasks.get(taskId);
          if (!task) {
            ws.close(4404, "task not found");
            return;
          }
          // DB reads and publishes are synchronous, so nothing can slip between the replay and the
          // subscription; the backlog goes out as one frame, like the run stream's.
          const detail = deps.tasks.detail(taskId)!;
          const backlog: Item[] = [
            ...deps.tasks.messages(taskId, afterSeq).map((message): Item => ({ t: "message", message })),
            { t: "task", task: detail.task },
            ...detail.runs.map((run): Item => ({ t: "run", run })),
          ];
          ws.send(JSON.stringify(backlog));
          unsubscribe = deps.tasks.subscribe(taskId, (item) => {
            ws.send(JSON.stringify([item]));
          });
        },
        onClose() {
          unsubscribe?.();
          unsubscribe = null;
        },
      };
    }),
  );
}
