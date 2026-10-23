import { validateFlow, type FlowDefinition, type RunnerCapabilities, type ServerMessage } from "@orch/protocol";
import { ulid } from "ulid";
import { createDeps } from "../src/app";
import { parseServerConfig } from "../src/config";
import { createDb, schema } from "../src/db";
import type { AppDeps } from "../src/deps";
import { GitHubApi } from "../src/github/api";
import type { GitHubCredentials } from "../src/github/credentials";
import { hashToken } from "../src/ws/runner";

export function testDeps(opts: { credentials?: GitHubCredentials; fetch?: typeof fetch } = {}): AppDeps {
  const config = parseServerConfig({ dataDir: "/nonexistent" }, "/");
  return createDeps(config, {
    db: createDb(":memory:"),
    webDist: "/nonexistent/dist",
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
    ...(opts.fetch ? { github: new GitHubApi(opts.fetch, "https://gh.test") } : {}),
  });
}

export function flowDef(over: Record<string, unknown> = {}): FlowDefinition {
  const v = validateFlow({
    name: "test flow",
    workspace: { kind: "local_path", path: "/Users/me/Documents/repo" },
    harness: { id: "omp", model: "anthropic/claude-sonnet-4-5" },
    steps: [
      { id: "impl", name: "Implement", kind: "prompt", prompt: "do it" },
      { id: "msg", name: "Commit message", kind: "prompt", prompt: "write msg" },
      { id: "commit", name: "Commit", kind: "git_commit", messageFrom: "msg" },
    ],
    ...over,
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.flow;
}

export function caps(over: Partial<RunnerCapabilities> = {}): RunnerCapabilities {
  return {
    labels: [],
    maxConcurrentJobs: 2,
    allowedRoots: ["/Users/me/Documents"],
    harnesses: [{ id: "omp", version: "18.10.3" }],
    sandboxProviders: ["docker"],
    acceptUntrusted: false,
    skills: [],
    commands: [],
    ...over,
  };
}

/** Registers a runner row; returns its id (the token is the id itself). */
export function addRunner(
  deps: AppDeps,
  id: string,
  over: Partial<typeof schema.runners.$inferInsert> = {},
): string {
  deps.db
    .insert(schema.runners)
    .values({ id, name: id, tokenHash: hashToken(id), labels: [], lastSeenAt: Date.now(), ...over })
    .run();
  return id;
}

export class FakeLink {
  readonly sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  of<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

/** Runner online in the hub with stored capabilities. */
export function connectRunner(deps: AppDeps, id: string, capabilities: RunnerCapabilities, over: Partial<typeof schema.runners.$inferInsert> = {}): FakeLink {
  addRunner(deps, id, { capabilities, ...over });
  const link = new FakeLink();
  deps.hub.attachRunner(id, link);
  return link;
}

export function addRun(
  deps: AppDeps,
  over: Partial<typeof schema.runs.$inferInsert> = {},
): string {
  const id = over.id ?? ulid();
  const definition = over.definition ?? flowDef();
  deps.db
    .insert(schema.runs)
    .values({
      id,
      flowId: "flow1",
      flowVersion: 1,
      definition,
      inputs: {},
      status: "queued",
      trust: "owner",
      triggerKind: "manual",
      createdAt: Date.now(),
      ...over,
    })
    .run();
  deps.db
    .insert(schema.runSteps)
    .values(definition.steps.map((s, idx) => ({ runId: id, stepId: s.id, idx, status: "pending" as const })))
    .run();
  return id;
}
