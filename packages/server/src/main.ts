import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { websocket } from "hono/bun";
import { ulid } from "ulid";
import { createApp, createDeps } from "./app";
import { loadServerConfig, type ServerConfig } from "./config";
import { createDb, schema } from "./db";
import { hashToken } from "./ws/runner";

const USAGE = `Usage:
  bun packages/server/src/main.ts [serve]
  bun packages/server/src/main.ts runner-token create --name <name> [--labels a,b]

Config: ORCH_SERVER_CONFIG (default ./orch.server.json)`;

function serve(config: ServerConfig): void {
  const deps = createDeps(config);
  const app = createApp(deps);
  // Bun.serve throws a descriptive error when the port is taken.
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch, websocket });
  deps.scheduler.start();
  deps.scheduler.kick();
  console.log(`[server] listening on http://${config.host}:${server.port} (public ${config.publicUrl}, data ${config.dataDir})`);
  const shutdown = (): void => {
    deps.scheduler.stop();
    void server.stop(true);
    deps.db.$client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function createRunnerToken(config: ServerConfig, argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: "string" }, labels: { type: "string" } },
    strict: true,
  });
  if (!values.name) {
    console.error(USAGE);
    process.exit(2);
  }
  const labels = (values.labels ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const db = createDb(join(config.dataDir, "orch.sqlite"));
  const token = randomBytes(32).toString("base64url");
  const id = ulid().toLowerCase();
  db.insert(schema.runners).values({ id, name: values.name, tokenHash: hashToken(token), labels }).run();
  db.$client.close();
  console.error(`Runner "${values.name}" registered. The token is shown only once; put both values in runner.json.`);
  console.log(`runnerId=${id}`);
  console.log(`token=${token}`);
}

const [cmd = "serve", ...rest] = process.argv.slice(2);
const config = loadServerConfig();
if (cmd === "serve") serve(config);
else if (cmd === "runner-token" && rest[0] === "create") createRunnerToken(config, rest.slice(1));
else {
  console.error(USAGE);
  process.exit(2);
}
