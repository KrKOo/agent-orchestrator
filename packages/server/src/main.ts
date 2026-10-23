import { join } from "node:path";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { websocket } from "hono/bun";
import { registerRunner } from "./api/runners";
import { createApp, createDeps } from "./app";
import { loadServerConfig, type ServerConfig } from "./config";
import { createDb, schema } from "./db";

const USAGE = `Usage:
  bun packages/server/src/main.ts [serve]
  bun packages/server/src/main.ts runner-token create --name <name> [--labels a,b] [--owner <github login>]

Config: ORCH_SERVER_CONFIG (default ./orch.server.json)`;

function serve(config: ServerConfig): void {
  const deps = createDeps(config);
  const app = createApp(deps);
  // Bun.serve throws a descriptive error when the port is taken.
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch, websocket });
  deps.scheduler.start();
  deps.scheduler.kick();
  console.log(
    `[server] listening on http://${config.host}:${server.port} (public ${config.publicUrl}, data ${config.dataDir}, auth ${config.auth.mode})`,
  );
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
    options: { name: { type: "string" }, labels: { type: "string" }, owner: { type: "string" } },
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
  let ownerUserId: string | null = null;
  if (values.owner) {
    const owner = db
      .select()
      .from(schema.users)
      .where(sql`lower(${schema.users.login}) = lower(${values.owner})`)
      .get();
    if (!owner) {
      console.error(`Unknown user "${values.owner}": they must log in to the web UI once before owning a runner.`);
      db.$client.close();
      process.exit(1);
    }
    ownerUserId = owner.id;
  }
  const { runnerId, token } = registerRunner(db, { name: values.name, labels, ownerUserId });
  db.$client.close();
  console.error(`Runner "${values.name}" registered. The token is shown only once; put both values in runner.json.`);
  console.log(`runnerId=${runnerId}`);
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
