import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import {
  type AgentStep,
  type AssignedRun,
  type CreatePullRequestParams,
  type CreatePullRequestResult,
  ElicitationAction,
  type GitHubTokenParams,
  type GitHubTokenResult,
  InterventionAction,
  type RunEventDraft,
  type RunnerMessage,
  REPO_RE,
  type Step,
  type TemplateContext,
  UNTRUSTED_PREAMBLE,
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
import { harnessRoleModels, harnesses } from "./harness/omp";
import { modelProvider } from "./harness/types";
import type { Library } from "./library";
import type { McpOutputServer, McpRunSink } from "./mcp-output";
import { OmpJsonTranslator } from "./omp-json";
import type { Mount, Sandbox, SandboxProvider } from "./sandbox/types";
import { SubagentTail } from "./subagent-tail";
import { checkoutDir, GITHUB_GIT_URL, type PreparedWorkspace, prepareWorkspace, resolveAllowedPath } from "./workspace";

export interface JobDeps {
  config: RunnerConfig;
  library: Library;
  gateway: Gateway;
  mcp: McpOutputServer;
  /** DockerSandboxProvider in prod, FakeSandbox in tests. */
  sandboxes: SandboxProvider;
  /** Outbox for seq continuation on resume (`seed`); emits go through `emit`. */
  seedOutbox(runId: string, seqFrom: number): void;
  /** → outbox.append */
  emit(draft: RunEventDraft): void;
  /** job.accepted / job.rejected / job.finished */
  send(msg: RunnerMessage): void;
  rpc<T>(method: RunnerRpcMethod, params: unknown): Promise<T>;
  /** Git origin for PR checkouts; defaults to `GITHUB_GIT_URL` (tests use a local `file://` dir). */
  githubGitUrl?: string;
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

type InterventionAnswer = { action: InterventionAction; session?: string; text?: string };

/** Id of the shared ACP session in an intervention's session list. */
const AGENT_SESSION = "agent";

/** A session an intervention can chat with; `resume` is the `omp -p` session id of slash sessions. */
interface ChatSession {
  label: string;
  /** Latest result: the last non-empty reply of the session. */
  output: string;
  /** Cap for one chat turn: the timeout of the step that last used the session. */
  timeoutSec: number;
  resume?: string;
}

/** Per succeeded step: the chat sessions as they were right after it (in the run dir, so it outlives attempts). */
const CHAT_SESSIONS_FILE = "chat-sessions.json";
type ChatSnapshots = Record<string, Record<string, ChatSession>>;

async function readChatSnapshots(runDir: string): Promise<ChatSnapshots> {
  try {
    return JSON.parse(await readFile(join(runDir, CHAT_SESSIONS_FILE), "utf8")) as ChatSnapshots;
  } catch {
    // First attempt here (e.g. a PR checkout retried on another runner): no sessions to restore.
    return {};
  }
}

type Answer = { optionId: string | null } | { action: ElicitationAction; content?: Record<string, unknown> } | InterventionAnswer;

/** Pending permission / elicitation / intervention requests of one run, answered by server messages. */
export class PendingRequests {
  private readonly waiters = new Map<string, (answer: Answer | null) => void>();

  /**
   * Resolves with the answer, or null on timeout / cancellation. A `undefined` timeout waits
   * indefinitely (intervention gates); the default caps permission/elicitation answers at 30 min.
   */
  wait(requestId: string, timeoutMs: number | undefined = ANSWER_TIMEOUT_MS): Promise<Answer | null> {
    const { promise, resolve } = Promise.withResolvers<Answer | null>();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => this.settle(requestId, null), timeoutMs);
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

/** Trimmed agent text with one enclosing code fence removed (models often fence "output only the message" replies). */
export function plainText(text: string): string {
  const trimmed = text.trim();
  const fenced = /^(`{3,})[^\n`]*\n([\s\S]*?)\n\1$/.exec(trimmed);
  return fenced ? fenced[2]!.trim() : trimmed;
}

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
    if (!run.github) return "Untrusted runs require a pull request";
    // Repo and shas become git argv and a URL path: reject anything but plain names and hex shas.
    const sha = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
    if (!REPO_RE.test(run.github.repo) || !sha.test(run.github.headSha) || !sha.test(run.github.baseSha)) return "Invalid pull request metadata";
  } else if (def.workspace.kind === "github_checkout") {
    return "github_checkout requires a pull request run";
  }
  try {
    if (def.workspace.kind === "local_path") await resolveAllowedPath(def.workspace.path, deps.config.allowedRoots);
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
  // Resume: prior succeeded outputs repopulate the template context; the loop starts at the cursor.
  const resume = run.resume;
  const fromStepIdx = resume?.fromStepIdx ?? 0;
  const ctx: TemplateContext = { inputs: run.inputs, steps: {} };
  for (const prior of resume?.prior ?? []) {
    ctx.steps[prior.stepId] = { output: prior.output, ...(prior.structured !== undefined ? { structured: prior.structured } : {}) };
  }
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
  /** Whether the current ACP session has been prompted; its first prompt carries the untrusted preamble.
   * A resumed run starts a fresh ACP session (ACP has no conversation resume), so this starts false. */
  let sessionPrompted = false;
  // `github_pr` requires an earlier `git_push`; on resume a skipped succeeded push counts.
  let pushed = resume?.prior.some((p) => def.steps.find((step) => step.id === p.stepId)?.kind === "git_push") ?? false;
  /** Sessions an intervention can chat with: `agent` (the ACP session) and `slash:<stepId>` (resumable `omp -p` runs). */
  const sessions = new Map<string, ChatSession>();
  // Chat sessions as of the cursor (the snapshot after the step before it), for interventions past it.
  // Slash sessions resume their omp session, whose file is in the run dir; the ACP agent session is new
  // and keeps only its last result.
  const chatSnapshots: ChatSnapshots = fromStepIdx > 0 ? await readChatSnapshots(runDir) : {};
  const lastAgentStep = def.steps.slice(0, fromStepIdx).findLast(isAgentStep);
  const restartedAgent = `Agent session (new after retry; last step: ${lastAgentStep?.name ?? "?"})`;
  for (const [id, chat] of Object.entries(chatSnapshots[def.steps[fromStepIdx - 1]?.id ?? ""] ?? {})) {
    sessions.set(id, { ...chat, ...(id === AGENT_SESSION ? { label: restartedAgent } : {}) });
  }
  // No snapshot (attempt 1 predates them, or ran on another runner): the agent step's output still seeds it.
  if (lastAgentStep && !sessions.has(AGENT_SESSION)) {
    const output = resume?.prior.find((p) => p.stepId === lastAgentStep.id)?.output ?? "";
    sessions.set(AGENT_SESSION, { label: restartedAgent, output, timeoutSec: lastAgentStep.timeoutSec });
  }

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
    const action: ElicitationAction = answer && "action" in answer && "content" in answer ? answer.action : "cancel";
    emit({ type: "acp.elicitation_resolved", payload: { requestId, action } }, stepId);
    if (action === "accept" && answer && "action" in answer && "content" in answer) return { action, content: elicitationContent(answer.content) ?? {} };
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

  /** One prompt turn in the current ACP session; updates stream under `eventStepId`, MCP output goes to `outputStepId`. */
  const agentTurn = async (text: string, eventStepId: string, outputStepId: string, abort: AbortSignal): Promise<StepOutcome> => {
    const h = harness!;
    activeStep = { id: outputStepId };
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
        emit({ type: "acp.update", payload: { update } }, eventStepId);
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

  const runAgentStep = async (step: AgentStep, abort: AbortSignal): Promise<StepOutcome> => {
    const freshContext = !sessionPrompted || step.freshSession;
    // Each session's first prompt carries the untrusted-data preamble (covers the first agent step).
    const text = run.trust === "untrusted" && freshContext ? `${UNTRUSTED_PREAMBLE}\n\n${agentPrompt(step)}` : agentPrompt(step);
    if (step.freshSession && sessionPrompted) await harness!.newSession();
    sessionPrompted = true;
    const outcome = await agentTurn(text, step.id, step.id, abort);
    sessions.set(AGENT_SESSION, { label: `Agent session (last step: ${step.name})`, output: outcome.output ?? "", timeoutSec: step.timeoutSec });
    return outcome;
  };

  /**
   * Lets the user chat with the run's sessions: each `message` answer sends its text verbatim to the
   * chosen session (replies stream under the gate), then the gate asks again. `continue` passes the
   * chosen session's latest result on as the gate output.
   */
  const runInterventionStep = async (step: Extract<Step, { kind: "intervention" }>, previous: Step | undefined, abort: AbortSignal): Promise<StepOutcome> => {
    const message = step.message ? renderTemplate(step.message, ctx) : "";
    // Preselect the session that produced the previous step's result.
    const previousSession = previous && isAgentStep(previous) ? AGENT_SESSION : previous?.kind === "slash" ? `slash:${previous.id}` : undefined;
    let selected = previousSession !== undefined && sessions.has(previousSession) ? previousSession : undefined;
    let error: string | undefined;
    for (;;) {
      const requestId = ulid();
      emit(
        {
          type: "intervention.request",
          payload: {
            requestId,
            message,
            sessions: [...sessions].map(([id, s]) => ({ id, label: s.label, output: s.output })),
            ...(selected !== undefined ? { session: selected } : {}),
            ...(error !== undefined ? { error } : {}),
          },
        },
        step.id,
      );
      emit({ type: "run.status", payload: { status: "awaiting_input" } });
      const answer = await pending.wait(requestId, step.timeoutSec === undefined ? undefined : step.timeoutSec * 1000);
      if (!answer || !("action" in answer) || answer.action === "cancel") {
        emit({ type: "intervention.resolved", payload: { requestId, action: "cancel" } }, step.id);
        // A null answer without a run cancel is the per-wait timeout.
        return !answer && !abort.aborted && step.timeoutSec !== undefined
          ? { status: "failed", error: `No answer within ${step.timeoutSec}s` }
          : { status: "cancelled" };
      }
      const { action, session: id = selected, text } = answer as InterventionAnswer;
      emit({ type: "intervention.resolved", payload: { requestId, action } }, step.id);
      const chat = id === undefined ? undefined : sessions.get(id);
      if (action === "continue") {
        emit({ type: "run.status", payload: { status: "running" } });
        return { status: "succeeded", output: chat?.output ?? "" };
      }

      if (!chat || !text?.trim()) {
        error = chat ? "The message is empty." : `Unknown session "${id ?? ""}".`;
        continue;
      }
      selected = id;
      emit({ type: "run.status", payload: { status: "running" } });
      emit({ type: "acp.update", payload: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } } }, step.id);
      const turnAbort = new AbortController();
      const onAbort = () => turnAbort.abort();
      abort.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        turnAbort.abort();
      }, chat.timeoutSec * 1000);
      let outcome: StepOutcome & { sessionId?: string };
      try {
        if (id === AGENT_SESSION) {
          // On a retried run this can be the fresh ACP session's first prompt.
          const agentText = run.trust === "untrusted" && !sessionPrompted ? `${UNTRUSTED_PREAMBLE}\n\n${text}` : text;
          sessionPrompted = true;
          outcome = await agentTurn(agentText, step.id, step.id, turnAbort.signal);
        } else {
          outcome = await slashRun(text, step.id, turnAbort.signal, chat.resume);
        }
      } catch (err) {
        outcome = { status: "failed", error: errorText(err) };
      } finally {
        clearTimeout(timer);
        abort.removeEventListener("abort", onAbort);
      }
      if (abort.aborted) return { status: "cancelled" };
      if (outcome.sessionId !== undefined) chat.resume = outcome.sessionId;
      // A turn that only ran tools keeps the previous result.
      if (outcome.status === "succeeded" && outcome.output?.trim()) chat.output = outcome.output;
      error = outcome.status === "succeeded" ? undefined : timedOut ? `No reply within ${chat.timeoutSec}s` : (outcome.error ?? "The turn failed.");
    }
  };

  /**
   * One headless `omp -p` run inside the sandbox (fresh, or resuming session `resume`). omp expands
   * slash commands, runs the prompt through the model (routed via the gateway), and the runner
   * streams its NDJSON progress events as `acp.update`s under `eventStepId` (same rendering as agent
   * steps). The final assistant text is the output; the `session` header gives the id to resume.
   */
  const slashRun = async (prompt: string, eventStepId: string, abort: AbortSignal, resume?: string): Promise<StepOutcome & { sessionId?: string }> => {
    // `--` stops omp flag parsing so args cannot inject launch flags; the text stays one argv element.
    const proc = sandbox!.exec([...adapter.printArgv(resume), "--", prompt], workspace!.hostPath);
    // Nothing is written to stdin; closing it ends omp's piped-input read so startup can proceed.
    void proc.stdin.close();
    const translator = new OmpJsonTranslator();
    // stdout is NDJSON for the translator, never output itself; only stderr is kept (for errors).
    const drain = async (stream: ReadableStream<Uint8Array>, stream2: "stdout" | "stderr"): Promise<string> => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of stream) {
        const part = decoder.decode(chunk, { stream: true });
        if (stream2 === "stdout") {
          // Translate before emitting so text deltas and tool cards stream like agent steps do.
          for (const update of translator.push(part)) emit({ type: "acp.update", payload: { update } }, eventStepId);
        } else {
          text += part;
        }
        emit({ type: "sandbox.log", payload: { stream: stream2, text: part } }, eventStepId);
      }
      return text;
    };
    try {
      const [, stderr, exitCode] = await rejectWhenAborted(
        Promise.all([drain(proc.stdout, "stdout"), drain(proc.stderr, "stderr"), proc.exited]),
        abort,
      );
      for (const update of translator.end()) emit({ type: "acp.update", payload: { update } }, eventStepId);
      const output = translator.result();
      const sessionId = translator.sessionId();
      if (abort.aborted) return { status: "cancelled", output };
      if (exitCode !== 0) return { status: "failed", output, error: `omp -p exited with code ${exitCode}: ${stderr.trim().slice(-500)}` };
      return { status: "succeeded", output, ...(sessionId !== undefined ? { sessionId } : {}) };
    } finally {
      // No-op after a normal exit; on abort (cancel, step or revision timeout) it stops the run.
      proc.kill();
    }
  };

  const runSlashStep = async (step: Extract<Step, { kind: "slash" }>, abort: AbortSignal): Promise<StepOutcome> => {
    const prompt = step.args && step.args.trim() ? `/${step.command} ${renderTemplate(step.args, ctx).trim()}` : `/${step.command}`;
    const { sessionId, ...outcome } = await slashRun(prompt, step.id, abort);
    if (sessionId !== undefined) {
      sessions.set(`slash:${step.id}`, { label: `/${step.command} (${step.name})`, output: outcome.output ?? "", timeoutSec: step.timeoutSec, resume: sessionId });
    }
    return outcome;
  };

  const runActionStep = async (step: Exclude<Step, AgentStep | { kind: "slash" } | { kind: "intervention" }>, abort: AbortSignal): Promise<StepOutcome> => {
    const ws = workspace!;
    if (step.kind === "git_commit") {
      const message = plainText(ctx.steps[step.messageFrom]?.output ?? "");
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
    const title = firstLine(plainText(ctx.steps[step.titleFrom]?.output ?? ""));
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

  /** `previous` is the step that ran right before `step` (an intervention gate reviews it). */
  const runStep = async (step: Step, previous: Step | undefined): Promise<StepOutcome> => {
    const abort = new AbortController();
    stepAbort = abort;
    let timedOut = false;
    // Gates cap each wait for an answer themselves (revisions run under the reviewed step's timeout).
    const timer =
      step.kind === "intervention"
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, step.timeoutSec * 1000);
    if (signal.aborted) abort.abort();
    const interrupted = (output?: string): StepOutcome =>
      timedOut && !signal.aborted
        ? { status: "failed", output, error: `Step timed out after ${step.timeoutSec}s` }
        : { status: "cancelled", output };
    try {
      const outcome = isAgentStep(step)
        ? await runAgentStep(step, abort.signal)
        : step.kind === "slash"
          ? await runSlashStep(step, abort.signal)
          : step.kind === "intervention"
            ? await runInterventionStep(step, previous, abort.signal)
            : await runActionStep(step, abort.signal);
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
      workspace = await prepareWorkspace(run, deps.config, {
        runDir,
        rpc: (method, params) => rejectWhenAborted(deps.rpc(method, params), signal),
        gitUrl: deps.githubGitUrl ?? GITHUB_GIT_URL,
        log: (text) => emit({ type: "sandbox.log", payload: { stream: "stderr", text } }),
        signal,
      });
      emit({
        type: "run.status",
        payload: {
          status: "running",
          workspace: {
            path: workspace.hostPath,
            ...(workspace.branch ? { branch: workspace.branch } : {}),
            ...(workspace.repo ? { repo: `${workspace.repo.owner}/${workspace.repo.name}` } : {}),
          },
        },
      });
      checkCancelled();

      const sessionsDir = join(runDir, "sessions");
      await mkdir(sessionsDir, { recursive: true });
      const roles = harnessRoleModels(def.harness);
      const providerFallback = [...new Set([...roles.values()].map((m) => modelProvider(m)).filter((p): p is string => p !== null))];
      const modelFallback = [...new Set(roles.values())].map((id) => {
        const i = id.indexOf("/");
        return { id, name: i > 0 ? id.slice(i + 1) : id };
      });
      const [providers, models] = await Promise.all([
        deps.gateway.listGatewayProviders(providerFallback),
        deps.gateway.listGatewayModels(modelFallback),
      ]);
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
        files: adapter.files(run, { url: `http://host.docker.internal:${deps.config.ports.gateway}`, providers, models }),
        env: adapter.env({ token: deps.gateway.token }),
        network: def.sandbox.network,
        cpus: def.sandbox.cpus,
        memoryMb: def.sandbox.memoryMb,
      });
      checkCancelled();

      tail = new SubagentTail(sessionsDir, (e) => emit(e, currentStepId), { fromEnd: resume !== undefined });
      tail.start();
      const mcp = deps.mcp.registerRun(runId, sink);
      mcpRegistered = true;
      // Slash-only flows never prompt the ACP harness; `omp -p` runs handle them inside the sandbox.
      if (def.steps.some(isAgentStep)) {
        harness = new AcpHarness({
          approval: def.approval,
          mcpServer: { type: "http", name: "orchestrator", url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${mcp.secret}` }] },
          onPermission,
          onElicitation,
          onLog: (stream, text) => emit({ type: "sandbox.log", payload: { stream, text } }, currentStepId),
        });
        await rejectWhenAborted(harness.start(sandbox!, adapter.acpArgv(run), workspace!.hostPath), signal);
        await rejectWhenAborted(harness.newSession(), signal);
      }

      for (const [i, step] of def.steps.entries()) {
        if (i < fromStepIdx) continue;
        if (signal.aborted) {
          status = "cancelled";
          break;
        }
        currentStepId = step.id;
        emit({ type: "step.started", payload: {} }, step.id);
        const outcome = await runStep(step, def.steps[i - 1]);
        ctx.steps[step.id] = { output: outcome.output ?? "", ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}) };
        emit({ type: "step.finished", payload: outcome }, step.id);
        if (outcome.status === "succeeded") {
          // Written even when empty so every succeeded step replaces any snapshot an older attempt left.
          // Copies: gate chats mutate sessions in place, which must not rewrite earlier snapshots.
          chatSnapshots[step.id] = Object.fromEntries([...sessions].map(([id, s]) => [id, { ...s }]));
          await writeFile(join(runDir, CHAT_SESSIONS_FILE), JSON.stringify(chatSnapshots)).catch((err) =>
            console.error(`[job ${runId}] chat sessions snapshot: ${errorText(err)}`),
          );
        }
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
    await (harness as AcpHarness | null)?.close().catch(() => {});
    await sandbox?.destroy().catch((err) => console.error(`[job ${runId}] sandbox destroy: ${errorText(err)}`));
    if (mcpRegistered) deps.mcp.unregisterRun(runId);
    if (def.workspace.kind === "github_checkout") {
      await rm(checkoutDir(deps.config, runId), { recursive: true, force: true }).catch((err) =>
        console.error(`[job ${runId}] checkout cleanup: ${errorText(err)}`),
      );
    }
  }
}

export class JobManager {
  /** `superseded`: a retry of the same run took over; the job's emits, messages and rpcs are dropped. */
  private readonly jobs = new Map<string, { abort: AbortController; pending: PendingRequests; superseded: boolean; done: Promise<void> }>();

  constructor(private readonly deps: JobDeps) {}

  /**
   * Validates, sends job.accepted | job.rejected, and runs the job in the background. A retry for a
   * run whose previous attempt is still here supersedes it: the old attempt is silenced (its events,
   * messages and rpcs would land on the retried run), aborted, and the retry takes over its slot once
   * it is done, so the outbox seed drops whatever the old attempt had queued.
   */
  assign(run: AssignedRun): void {
    const previous = this.jobs.get(run.runId);
    if (!previous && this.jobs.size >= this.deps.config.maxConcurrentJobs) {
      this.deps.send({ t: "job.rejected", runId: run.runId, reason: "Runner at capacity" });
      return;
    }
    if (previous) {
      previous.superseded = true;
      previous.abort.abort();
    }
    const abort = new AbortController();
    const pending = new PendingRequests();
    const job = { abort, pending, superseded: false, done: Promise.resolve() };
    const deps: JobDeps = {
      ...this.deps,
      emit: (draft) => {
        if (!job.superseded) this.deps.emit(draft);
      },
      send: (msg) => {
        if (!job.superseded) this.deps.send(msg);
      },
      rpc: <T>(method: RunnerRpcMethod, params: unknown) =>
        job.superseded ? Promise.reject<T>(new Error("Superseded by a retry")) : this.deps.rpc<T>(method, params),
    };
    const start = async () => {
      await previous?.done;
      // Cancelled while waiting for the previous attempt: never started, let the server close it.
      if (abort.signal.aborted) {
        deps.send({ t: "job.finished", runId: run.runId, status: "cancelled" });
        return;
      }
      if (run.seqFrom !== undefined) this.deps.seedOutbox(run.runId, run.seqFrom);
      await runJob(run, deps, abort.signal, pending);
    };
    job.done = start()
      .catch((err) => console.error(`[job ${run.runId}] crashed: ${errorText(err)}`))
      .finally(() => {
        if (this.jobs.get(run.runId) === job) this.jobs.delete(run.runId);
      });
    this.jobs.set(run.runId, job);
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

  respondIntervention(runId: string, requestId: string, msg: InterventionAnswer): void {
    this.jobs.get(runId)?.pending.settle(requestId, {
      action: msg.action,
      ...(msg.session !== undefined ? { session: msg.session } : {}),
      ...(msg.text !== undefined ? { text: msg.text } : {}),
    });
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
