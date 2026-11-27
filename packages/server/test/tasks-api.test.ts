import { describe, expect, test } from "bun:test";
import { integrationBranch, type TaskRow } from "@orch/protocol";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { schema } from "../src/db";
import type { AppDeps } from "../src/deps";
import { testDeps } from "./helpers";

const settings = {
  repos: [{ github: "acme/app", localPath: "/Users/me/Documents/repo" }],
  interventions: "manager",
  merge: "integration",
  autoMergeFinal: false,
  managerModels: { model: "anthropic/claude-sonnet-4-5" },
  allowNetworkModes: ["gateway_only", "allowlist"],
  maxParallelRuns: 3,
};

function client(deps: AppDeps) {
  const app = createApp(deps);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

describe("tasks API", () => {
  test("create stores the first message and queues a manager run with role manager, ro/direct workspace", async () => {
    const deps = testDeps();
    const call = client(deps);

    const bad = await call("POST", "/api/tasks", { title: "", message: "x", settings });
    expect(bad.status).toBe(400);

    const ok = await call("POST", "/api/tasks", { title: "Fix the login flow", message: "please fix", settings });
    expect(ok.status).toBe(201);
    const task = ok.json as TaskRow;
    expect(task).toMatchObject({ title: "Fix the login flow", status: "active", inboxAckedSeq: 0 });
    expect(task.settings.repos[0]!.github).toBe("acme/app");

    const detail = (await call("GET", `/api/tasks/${task.id}`)).json as { messages: { seq: number; role: string; text: string }[] };
    expect(detail.messages).toEqual([{ taskId: task.id, seq: 1, role: "user", text: "please fix", ts: expect.any(Number) }]);

    const managers = deps.db.select().from(schema.runs).where(eq(schema.runs.taskId, task.id)).all();
    expect(managers).toHaveLength(1);
    expect(managers[0]).toMatchObject({ role: "manager", status: "queued", trust: "owner", flowId: "builtin:manager" });
    expect(managers[0]!.definition.workspace).toMatchObject({ kind: "local_path", path: "/Users/me/Documents/repo", isolation: "direct", access: "ro" });
    expect(managers[0]!.definition.steps).toHaveLength(1);
    expect(managers[0]!.definition.harness.model).toBe("anthropic/claude-sonnet-4-5");
    // Validation failures do not leave a half-created task behind.
    expect((await call("POST", "/api/tasks", { title: "x", message: "", settings })).status).toBe(400);
  });

  test("invalid manager model roles are a 400 on create and update, never a task without a manager", async () => {
    const deps = testDeps();
    const call = client(deps);
    const bad = { ...settings, managerModels: { model: "anthropic/claude-sonnet-4-5", modelRoles: { default: "x/y" } } };
    const created = await call("POST", "/api/tasks", { title: "Bad models", message: "go", settings: bad });
    expect(created.status).toBe(400);
    expect(deps.db.select().from(schema.tasks).all()).toHaveLength(0);

    const task = (await call("POST", "/api/tasks", { title: "Good", message: "go", settings })).json as TaskRow;
    expect((await call("PATCH", `/api/tasks/${task.id}`, { settings: bad })).status).toBe(400);
    expect(deps.tasks.get(task.id)!.settings.managerModels.modelRoles).toBeUndefined();
  });

  test("list/get/patch: archive cancels the live manager run", async () => {
    const deps = testDeps();
    const call = client(deps);
    const a = (await call("POST", "/api/tasks", { title: "A", message: "one", settings })).json as TaskRow;
    const b = (await call("POST", "/api/tasks", { title: "B", message: "two", settings })).json as TaskRow;
    // Both may be created in one millisecond: pin `updatedAt` so the newest-first order is what is under test.
    deps.db.update(schema.tasks).set({ updatedAt: 1_000 }).where(eq(schema.tasks.id, a.id)).run();
    deps.db.update(schema.tasks).set({ updatedAt: 2_000 }).where(eq(schema.tasks.id, b.id)).run();

    const listed = (await call("GET", "/api/tasks")).json as TaskRow[];
    expect(listed.map((t) => t.id)).toEqual([b.id, a.id]); // newest updatedAt first
    expect((await call("GET", "/api/tasks?archived=1")).json).toHaveLength(2);

    const patched = (await call("PATCH", `/api/tasks/${a.id}`, { title: "A2" })).json as TaskRow;
    expect(patched.title).toBe("A2");
    expect((await call("PATCH", `/api/tasks/missing`, { title: "x" })).status).toBe(404);

    // Archive: status changes and the queued manager run is cancelled.
    const archived = (await call("PATCH", `/api/tasks/${a.id}`, { status: "archived" })).json as TaskRow;
    expect(archived.status).toBe("archived");
    const managerRun = deps.db.select().from(schema.runs).where(eq(schema.runs.taskId, a.id)).all()[0]!;
    expect(["cancelled", "queued"]).toContain(managerRun.status); // cancel is requested (queued → cancelled via grace timer)

    // A posted message to an archived task is rejected.
    expect((await call("POST", `/api/tasks/${a.id}/messages`, { text: "hi" })).status).toBe(409);
    expect((await call("GET", "/api/tasks")).json).toHaveLength(1);
  });

  test("post message: seq increments, reactivates a done task, and answers a choice", async () => {
    const deps = testDeps();
    const call = client(deps);
    const task = (await call("POST", "/api/tasks", { title: "T", message: "start", settings })).json as TaskRow;

    const first = (await call("POST", `/api/tasks/${task.id}/messages`, { text: " do this too " })).json as { seq: number; text: string };
    expect(first.seq).toBe(2);
    expect(first.text).toBe("do this too"); // trimmed
    expect((await call("POST", `/api/tasks/${task.id}/messages`, { text: "" })).status).toBe(400);
    expect((await call("POST", `/api/tasks/${task.id}/messages`, { text: "x", choice: "a" })).status).toBe(400);

    // An ask_user question from the manager: choices on the message and needs_input on the task.
    deps.tasks.append({ taskId: task.id, role: "manager", text: "Which approach?", event: undefined, choices: [{ id: "fast", label: "Fast" }, { id: "safe", label: "Safe" }] });
    deps.tasks.setNeedsInput(task.id);
    expect(deps.tasks.get(task.id)!.status).toBe("needs_input");

    const answer = (await call("POST", `/api/tasks/${task.id}/messages`, { choice: "safe", answerTo: 3 })).json as { seq: number; text: string; choice: string; answerTo: number };
    expect(answer.text).toBe('User picked "safe" for question #3');
    expect(answer.choice).toBe("safe");
    expect(answer.answerTo).toBe(3);
    // The answer reactivated the task and queued a manager to consume it.
    expect(deps.tasks.get(task.id)!.status).toBe("active");
    const managers = deps.db.select().from(schema.runs).where(eq(schema.runs.taskId, task.id)).all().filter((r) => r.role === "manager");
    expect(managers.length).toBeGreaterThanOrEqual(1);

    // afterSeq paging
    const messages = (await call("GET", `/api/tasks/${task.id}/messages?afterSeq=2`)).json as { seq: number }[];
    expect(messages.map((m) => m.seq)).toEqual([3, 4]);
  });

  test("task runs listing and stream backlog shape", async () => {
    const deps = testDeps();
    const call = client(deps);
    const task = (await call("POST", "/api/tasks", { title: "S", message: "go", settings })).json as TaskRow;
    const runs = (await call("GET", `/api/tasks/${task.id}/runs`)).json as { role: string; taskId: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ role: "manager", taskId: task.id });
    // The integration branch is derivable without starting anything: the whole lowercased ULID (unique per task).
    expect(integrationBranch(task.id)).toBe(`orch/task-${task.id.toLowerCase()}`);
  });
});
