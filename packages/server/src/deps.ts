import type { ServerConfig } from "./config";
import type { Db } from "./db";
import type { GitHubApi } from "./github/api";
import type { GitHubCredentials } from "./github/credentials";
import type { Hub } from "./hub";
import type { RunService } from "./runs";
import type { Scheduler } from "./scheduler";

/** Everything route and WebSocket handlers need; tests build it around an in-memory DB. */
export interface AppDeps {
  config: ServerConfig;
  db: Db;
  hub: Hub;
  runs: RunService;
  scheduler: Scheduler;
  credentials: GitHubCredentials;
  github: GitHubApi;
  /** Absolute path of the built web UI (`packages/web/dist`). */
  webDist: string;
}
