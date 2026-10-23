import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  type AgentStep,
  type AssignedRun,
  type CreatePullRequestParams,
  type CreatePullRequestResult,
  type ElicitationAction,
  type GitHubTokenParams,
  type GitHubTokenResult,
  type RunEventDraft,
  type RunnerMessage,
  type Step,
  type TemplateContext,
  isActionStep,
  isAgentStep,
  renderTemplate,
  validateFlow,
} from "@orch/protocol";
import { ulid } from "ulid";
import { AcpHarness } from "./acp-session";
import type { RunnerConfig } from "./config";
import type { RunnerRpcMethod } from "./connection";
import type { Gateway } from "./gateway";
import { commitAll, pushBranch } from "./git";
import { harnesses } from "./harness/omp";
import { modelProvider } from "./harness/types";
import type { Library } from "./library";
import type { McpOutputServer, McpRunSink } from "./mcp-output";
import type { Mount, Sandbox, SandboxProvider } from "./sandbox/types";
import { SubagentTail } from "./subagent-tail";
import { type PreparedWorkspace, prepareWorkspace, resolveAllowedPath } from "./workspace";

export interface JobDeps {
  config: RunnerConfig;
  library: Library;
  gateway: Gateway;
  mcp: McpOutputServer;
  /** DockerSandboxProvider in prod, FakeSandbox in tests. */
  sandboxes: SandboxProvider;
  /** → outbox.append */
  emit(draft: RunEventDraft): void;
  /** job.accepted / job.rejected / job.finished */
  send(msg: RunnerMessage): void;
  rpc<T>(method: RunnerRpcMethod, params: unknown): Promise<T>;
}

/** Time a user has to answer a permission or elicitation request. */
const ANSWER_TIMEOUT_MS = 30 * 60_000;
/** Grace period between asking the agent to stop and tearing the sandbox down. */
const CANCEL_GRACE_MS = 10_000;

/** `{type, payload}` of every run event, correlated (distributes over the event union). */
type EventBody = RunEventDraft extends infer E ? (E extends { type: infer T; payload: infer P } ? { type: T; payload: P } : never) : never;

type StepOutcome = {
  status: "succeeded" | "failed" | "cancelled";
  output?: string;
  structured?: unknown;
  error?: string;
};

type Answer = { optionId: string | null } | { action: ElicitationAction; content?: Record<string, unknown> };

/** Pending permission / elicitation requests of one run, answered by server messages. */
export class PendingRequests {
  private readonly waiters = new Map<string, (answer: Answer | null) => void>();

  /** Resolves with the answer, or null on timeout / cancellation. */
  wait(requestId: string, timeoutMs = ANSWER_TIMEOUT_MS): Promise<Answer | null> {
    const { promise, resolve } = Promise.withResolvers<Answer | null>();
    const timer = setTimeout(() => this.settle(requestId, null), timeoutMs);
    this.waiters.set(requestId, (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
    return promise;
  }

  settle(requestId: string, answer: Answer | null): void {
    const waiter = this.waiters.get(requestId);
    this.waiters.delete(requestId);
    waiter?.(answer);
  }

  cancelAll(): void {
    for (const id of [...this.waiters.keys()]) this.settle(id, null);
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  );
}

/** Container dir name for a skill (`/orch/skills/<dir>`). */
const skillDirName = (name: string) => name.replace(/[^\w.-]/g, "_");

function rejectWhenAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  if (signal.aborted) reject(new Error("aborted"));
  signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  p.then(resolve, reject);
  return promise;
}

/** Elicitation content values ACP accepts; anything else is dropped. */
function elicitationContent(content: Record<string, unknown> | undefined): Record<string, acp.ElicitationContentValue> | undefined {
  if (!content) return undefined;
  const out: Record<string, acp.ElicitationContentValue> = {};
  for (const [k, v] of Object.entries(content)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v;
  }
  return out;
}

/** Trust re-validation; the runner never relies on the server for these checks. */
async function rejectReason(run: AssignedRun, deps: JobDeps): Promise<string | null> {
  const def = run.definition;
  if (!harnesses[def.harness.id]) return `Unknown harness: ${def.harness.id}`;
  const validated = validateFlow(def);
  if (!validated.ok) return `Invalid flow: ${validated.errors.join("; ")}`;
  if (run.trust === "untrusted") {
    if (!deps.config.acceptUntrusted) return "Runner does not accept untrusted runs";
    if (def.workspace.kind === "local_path") return "Untrusted runs cannot mount local paths";
    if (def.steps.some(isActionStep)) return "Untrusted runs cannot run action steps";
    if (def.approval === "ask") return "Untrusted runs cannot use approval: ask";
    if (def.sandbox.network.mode === "open") return "Untrusted runs cannot use open network";
  }
  try {
    await resolveAllowedPath(def.workspace.path, deps.config.allowedRoots);
    const lookupAll = () => {
      for (const step of def.steps) {
        if (step.kind === "skill") deps.library.getSkill(step.skill);
        if (step.kind === "command") deps.library.getCommand(step.command);
      }
    };
    try {
      lookupAll();
    } catch {
      // The periodic rescan may not have seen a newly added skill/command yet.
      await deps.library.scan();
      lookupAll();
    }
  } catch (err) {
    return errorText(err);
  }
  return null;
}

/**
 * Executes one assigned run end to end. Sends `job.accepted`/`job.rejected` and `job.finished`;
 * every run event goes through `deps.emit`. `signal` aborts the run (cancel).
 */
export async function runJob(run: AssignedRun, deps: JobDeps, signal: AbortSignal, pending = new PendingRequests()): Promise<void> {
  const { runId, definition: def } = run;
  const emit = (body: EventBody, stepId?: string) =>
    // `body` is one correlated {type, payload} member; adding envelope fields keeps it a RunEventDraft.
    deps.emit({ ...body, runId, ts: Date.now(), ...(stepId !== undefined ? { stepId } : {}) } as RunEventDraft);

  const reason = await rejectReason(run, deps);
  if (reason) {
    deps.send({ t: "job.rejected", runId, reason });
    return;
  }
  deps.send({ t: "job.accepted", runId });

  const adapter = harnesses[def.harness.id]!;
  const runDir = join(deps.config.dataDir, "runs", runId);
  const ctx: TemplateContext = { inputs: run.inputs, steps: {} };
  let status: StepOutcome["status"] = "succeeded";
  let error: string | undefined;
  let workspace: PreparedWorkspace | null = null;
  let sandbox: Sandbox | null = null;
  let harness: AcpHarness | null = null;
  let tail: SubagentTail | null = null;
  let mcpRegistered = false;
  /** Step that events (logs, subagents, permissions) are attributed to. */
  let currentStepId: string | undefined;
  /** Agent step accepting MCP output, with its structured result. */
  let activeStep: { id: string; structured?: unknown } | null = null;
  let stepAbort: AbortController | null = null;
  let sessionPrompted = false;
  let pushed = false;

  const onCancel = () => {
    stepAbort?.abort();
    pending.cancelAll();
  };
  signal.addEventListener("abort", onCancel, { once: true });
  const checkCancelled = () => {
    if (signal.aborted) throw new Error("Cancelled");
  };

  const sink: McpRunSink = {
    submitOutput(value) {
      if (!activeStep) return "No active step";
      activeStep.structured = value;
      return null;
    },
    reportFinding(f) {
      if (!activeStep) return "No active step";
      emit({ type: "finding", payload: f }, activeStep.id);
      return null;
    },
  };

  const onPermission = async (req: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> => {
    const options = req.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));
    if (def.approval === "auto") {
      const pick = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always") ?? options[0];
      return { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } };
    }
    const requestId = ulid();
    const stepId = currentStepId;
    emit({ type: "acp.permission_request", payload: { requestId, toolCall: req.toolCall, options } }, stepId);
    const answer = await pending.wait(requestId);
    const chosen = answer && "optionId" in answer ? answer.optionId : null;
    const optionId = options.some((o) => o.optionId === chosen) ? chosen : null;
    emit({ type: "acp.permission_resolved", payload: { requestId, optionId } }, stepId);
    return { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } };
  };

  const onElicitation = async (req: { message: string; requestedSchema: unknown }): Promise<acp.CreateElicitationResponse> => {
    if (def.approval !== "ask") return { action: "decline" };
    const requestId = ulid();
    const stepId = currentStepId;
    emit({ type: "acp.elicitation_request", payload: { requestId, message: req.message, requestedSchema: req.requestedSchema } }, stepId);
    const answer = await pending.wait(requestId);
    const action: ElicitationAction = answer && "action" in answer ? answer.action : "cancel";
    emit({ type: "acp.elicitation_resolved", payload: { requestId, action } }, stepId);
    if (action === "accept" && answer && "action" in answer) return { action, content: elicitationContent(answer.content) ?? {} };
    return { action };
  };

  const agentPrompt = (step: AgentStep): string => {
    if (step.kind === "prompt") return renderTemplate(step.prompt, ctx);
    if (step.kind === "skill") {
      const skill = deps.library.getSkill(step.skill);
      const lines = [
        `Apply the skill "${skill.name}" now. Follow its instructions exactly.`,
        `<skill name="${skill.name}">`,
        skill.body.trim(),
        "</skill>",
        `[Skill directory: /orch/skills/${skillDirName(skill.name)}]`,
      ];
      if (step.args) lines.push(`Arguments: ${renderTemplate(step.args, ctx)}`);
      return lines.join("\n");
    }
    const command = deps.library.getCommand(step.command);
    return command.body.replaceAll("$ARGUMENTS", renderTemplate(step.args ?? "", ctx));
  };

  const runAgentStep = async (step: AgentStep, abort: AbortSignal): Promise<StepOutcome> => {
    const h = harness!;
    const text = agentPrompt(step);
    if (step.freshSession && sessionPrompted) await h.newSession();
    sessionPrompted = true;
    activeStep = { id: step.id };
    let output = "";
    let afterToolCall = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      void h.cancel();
      // Agent ignored the cancel: tear the sandbox down, which ends the prompt turn.
      grace = setTimeout(() => {
        void h.close();
        void sandbox?.destroy();
      }, CANCEL_GRACE_MS);
    };
    abort.addEventListener("abort", onAbort, { once: true });
    try {
      const { stopReason } = await h.prompt(text, (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          // Text resumed after a tool call starts a new paragraph instead of running on.
          if (afterToolCall && output) output += "\n\n";
          afterToolCall = false;
          output += update.content.text;
        } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          afterToolCall = true;
        }
        emit({ type: "acp.update", payload: { update } }, step.id);
      });
      const structured = activeStep.structured;
      if (abort.aborted) return { status: "cancelled", output };
      if (stopReason === "end_turn") return { status: "succeeded", output, ...(structured !== undefined ? { structured } : {}) };
      if (stopReason === "cancelled") return { status: "cancelled", output };
      return { status: "failed", output, error: `Agent stopped: ${stopReason}` };
    } finally {
      abort.removeEventListener("abort", onAbort);
      clearTimeout(grace);
      activeStep = null;
    }
  };

  const runActionStep = async (step: Exclude<Step, AgentStep>, abort: AbortSignal): Promise<StepOutcome> => {
    const ws = workspace!;
    if (step.kind === "git_commit") {
      const message = ctx.steps[step.messageFrom]?.output.trim() ?? "";
      if (!message) throw new Error(`Commit message from step ${step.messageFrom} is empty`);
      const file = join(runDir, "commit-msg");
      await writeFile(file, `${message}\n`);
      return { status: "succeeded", output: await commitAll(ws.hostPath, file, deps.config.git, abort) };
    }
    if (!ws.repo) throw new Error("No GitHub origin remote");
    if (!ws.branch) throw new Error(`${step.kind} requires worktree isolation`);
    const repo = `${ws.repo.owner}/${ws.repo.name}`;
    if (step.kind === "git_push") {
      const params: GitHubTokenParams = { runId, repo, access: "write" };
      const { token } = await rejectWhenAborted(deps.rpc<GitHubTokenResult>("github.token", params), abort);
      await pushBranch(ws.hostPath, ws.repo, ws.branch, token, abort);
      pushed = true;
      return { status: "succeeded", output: ws.branch };
    }
    if (!pushed) throw new Error("github_pr requires an earlier git_push");
    const title = firstLine(ctx.steps[step.titleFrom]?.output ?? "");
    if (!title) throw new Error(`PR title from step ${step.titleFrom} is empty`);
    const params: CreatePullRequestParams = {
      runId,
      repo,
      head: ws.branch,
      base: step.base ?? null,
      title,
      body: ctx.steps[step.bodyFrom]?.output ?? "",
      draft: step.draft,
    };
    const pr = await rejectWhenAborted(deps.rpc<CreatePullRequestResult>("github.createPullRequest", params), abort);
    return { status: "succeeded", output: pr.url };
  };

  const runStep = async (step: Step): Promise<StepOutcome> => {
    const abort = new AbortController();
    stepAbort = abort;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, step.timeoutSec * 1000);
    if (signal.aborted) abort.abort();
    const interrupted = (output?: string): StepOutcome =>
      timedOut && !signal.aborted
        ? { status: "failed", output, error: `Step timed out after ${step.timeoutSec}s` }
        : { status: "cancelled", output };
    try {
      const outcome = isAgentStep(step) ? await runAgentStep(step, abort.signal) : await runActionStep(step, abort.signal);
      return outcome.status === "cancelled" && abort.signal.aborted ? interrupted(outcome.output) : outcome;
    } catch (err) {
      return abort.signal.aborted ? interrupted() : { status: "failed", error: errorText(err) };
    } finally {
      clearTimeout(timer);
      stepAbort = null;
    }
  };

  try {
    try {
      workspace = await prepareWorkspace(run, deps.config);
      emit({
        type: "run.status",
        payload: { status: "running", workspace: { path: workspace.hostPath, ...(workspace.branch ? { branch: workspace.branch } : {}) } },
      });
      checkCancelled();

      const sessionsDir = join(runDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });
      const { model, smolModel } = def.harness;
      const fallback = [model, smolModel].flatMap((m) => (m ? (modelProvider(m) ?? []) : []));
      const providers = await deps.gateway.listGatewayProviders([...new Set(fallback)]);
      const skillMounts: Mount[] = [];
      for (const step of def.steps) {
        if (step.kind !== "skill") continue;
        const skill = deps.library.getSkill(step.skill);
        const containerPath = `/orch/skills/${skillDirName(skill.name)}`;
        if (!skillMounts.some((m) => m.containerPath === containerPath)) {
          skillMounts.push({ hostPath: skill.dir, containerPath, readonly: true });
        }
      }
      sandbox = await deps.sandboxes.create({
        runId,
        image: def.sandbox.image,
        mounts: [...workspace.mounts, ...adapter.mounts(run, runDir), ...skillMounts],
        files: adapter.files(run, { url: `http://host.docker.internal:${deps.config.ports.gateway}`, providers }),
        env: adapter.env({ token: deps.gateway.token }),
        network: def.sandbox.network,
        cpus: def.sandbox.cpus,
        memoryMb: def.sandbox.memoryMb,
      });
      checkCancelled();

      tail = new SubagentTail(sessionsDir, (e) => emit(e, currentStepId));
      tail.start();
      const mcp = deps.mcp.registerRun(runId, sink);
      mcpRegistered = true;
      harness = new AcpHarness({
        approval: def.approval,
        mcpServer: { type: "http", name: "orchestrator", url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${mcp.secret}` }] },
        onPermission,
        onElicitation,
        onLog: (stream, text) => emit({ type: "sandbox.log", payload: { stream, text } }, currentStepId),
      });
      await rejectWhenAborted(harness.start(sandbox, adapter.acpArgv(run), workspace.hostPath), signal);
      await rejectWhenAborted(harness.newSession(), signal);

      for (const step of def.steps) {
        if (signal.aborted) {
          status = "cancelled";
          break;
        }
        currentStepId = step.id;
        emit({ type: "step.started", payload: {} }, step.id);
        const outcome = await runStep(step);
        ctx.steps[step.id] = { output: outcome.output ?? "", ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}) };
        emit({ type: "step.finished", payload: outcome }, step.id);
        if (outcome.status !== "succeeded") {
          status = outcome.status;
          error = outcome.error;
          break;
        }
      }
    } catch (err) {
      status = signal.aborted ? "cancelled" : "failed";
      error = signal.aborted ? undefined : errorText(err);
    }

    if (tail) {
      await tail.stop();
      await tail.poll();
    }
    emit({ type: "run.status", payload: { status, ...(error !== undefined ? { error } : {}) } });
    deps.send({ t: "job.finished", runId, status, ...(error !== undefined ? { error } : {}) });
  } finally {
    signal.removeEventListener("abort", onCancel);
    pending.cancelAll();
    await harness?.close().catch(() => {});
    await sandbox?.destroy().catch((err) => console.error(`[job ${runId}] sandbox destroy: ${errorText(err)}`));
    if (mcpRegistered) deps.mcp.unregisterRun(runId);
  }
}

export class JobManager {
  private readonly jobs = new Map<string, { abort: AbortController; pending: PendingRequests; done: Promise<void> }>();

  constructor(private readonly deps: JobDeps) {}

  /** Validates, sends job.accepted | job.rejected, and runs the job in the background. */
  assign(run: AssignedRun): void {
    if (this.jobs.has(run.runId)) return;
    if (this.jobs.size >= this.deps.config.maxConcurrentJobs) {
      this.deps.send({ t: "job.rejected", runId: run.runId, reason: "Runner at capacity" });
      return;
    }
    const abort = new AbortController();
    const pending = new PendingRequests();
    const done = runJob(run, this.deps, abort.signal, pending)
      .catch((err) => console.error(`[job ${run.runId}] crashed: ${errorText(err)}`))
      .finally(() => this.jobs.delete(run.runId));
    this.jobs.set(run.runId, { abort, pending, done });
  }

  cancel(runId: string): void {
    const job = this.jobs.get(runId);
    if (job) {
      job.abort.abort();
      return;
    }
    // Not running here (e.g. runner restarted): let the server close the run.
    this.deps.send({ t: "job.finished", runId, status: "cancelled" });
  }

  respondPermission(runId: string, requestId: string, optionId: string | null): void {
    this.jobs.get(runId)?.pending.settle(requestId, { optionId });
  }

  respondElicitation(runId: string, requestId: string, action: ElicitationAction, content?: Record<string, unknown>): void {
    this.jobs.get(runId)?.pending.settle(requestId, { action, ...(content ? { content } : {}) });
  }

  activeCount(): number {
    return this.jobs.size;
  }

  async shutdown(): Promise<void> {
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.abort.abort();
    await Promise.allSettled(jobs.map((j) => j.done));
  }
}
