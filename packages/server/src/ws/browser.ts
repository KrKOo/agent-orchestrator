import type { RunEvent } from "@orch/protocol";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { schema } from "../db";
import type { AppDeps } from "../deps";
import { eventRow } from "../rows";
import { sessionUser } from "../auth/session";

const { runEvents } = schema;

/** Persisted events of a run with `seq > afterSeq`, in order. */
export function eventsAfter(deps: Pick<AppDeps, "db">, runId: string, afterSeq: number): RunEvent[] {
  return deps.db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .all()
    .map(eventRow);
}

/** Only same-origin browsers (or clients sending no Origin) may subscribe, in every auth mode. */
export function originAllowed(deps: Pick<AppDeps, "config">, origin: string | undefined): boolean {
  return origin === undefined || origin === deps.config.publicUrl;
}

export function registerBrowserWs(app: Hono, deps: AppDeps): void {
  app.get(
    "/api/runs/:id/stream",
    upgradeWebSocket((c) => {
      const runId = c.req.param("id")!;
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
          if (!deps.runs.get(runId)) {
            ws.close(4404, "run not found");
            return;
          }
          // DB reads and publishes are synchronous, so nothing can slip between the replay and the subscription.
          let last = afterSeq;
          for (const ev of eventsAfter(deps, runId, afterSeq)) {
            ws.send(JSON.stringify(ev));
            last = ev.seq;
          }
          unsubscribe = deps.hub.subscribe(runId, (ev) => {
            if (ev.seq <= last) return;
            last = ev.seq;
            ws.send(JSON.stringify(ev));
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
