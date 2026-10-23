import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import type { RunnerMessage, ServerMessage } from "@orch/protocol";
import { Connection } from "../src/connection";

let server: Server<unknown> | undefined;
let conn: Connection | undefined;

afterEach(() => {
  conn?.stop();
  server?.stop(true);
});

test("sends bearer header, runs onOpen first, dispatches messages, and correlates RPC results", async () => {
  const authHeaders: (string | null)[] = [];
  const received: RunnerMessage[] = [];
  const gotMessage = Promise.withResolvers<ServerMessage>();
  const gotRpcCall = Promise.withResolvers<void>();

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      authHeaders.push(req.headers.get("authorization"));
      return srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as RunnerMessage;
        received.push(msg);
        if (msg.t === "ping") ws.send(JSON.stringify({ t: "welcome", lastAckedSeq: { r1: 3 } }));
        if (msg.t === "rpc.call") {
          ws.send(JSON.stringify({ t: "rpc.result", rpcId: msg.rpcId, ok: true, result: { token: "tok" } }));
          gotRpcCall.resolve();
        }
      },
    },
  });

  conn = new Connection({
    url: `ws://127.0.0.1:${server.port}/runner/ws`,
    token: "secret",
    onOpen: () => conn?.send({ t: "ping" }),
    onMessage: (msg) => gotMessage.resolve(msg),
  });
  // RPC issued before connecting is queued and sent after onOpen.
  const result = conn.rpc<{ token: string }>("github.token", { runId: "r1", repo: "o/r", access: "write" });
  conn.start();

  expect(await gotMessage.promise).toEqual({ t: "welcome", lastAckedSeq: { r1: 3 } });
  expect(await result).toEqual({ token: "tok" });
  await gotRpcCall.promise;
  expect(authHeaders).toEqual(["Bearer secret"]);
  expect(received[0]).toEqual({ t: "ping" });
  expect(received.some((m) => m.t === "rpc.call" && m.method === "github.token")).toBe(true);
});

test("rejected RPC surfaces the server error", async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as RunnerMessage;
        if (msg.t === "rpc.call") ws.send(JSON.stringify({ t: "rpc.result", rpcId: msg.rpcId, ok: false, error: "forbidden" }));
      },
    },
  });
  conn = new Connection({ url: `ws://127.0.0.1:${server.port}/`, token: "t", onOpen: () => {}, onMessage: () => {} });
  conn.start();
  await expect(conn.rpc("github.createPullRequest", {})).rejects.toThrow("forbidden");
});
