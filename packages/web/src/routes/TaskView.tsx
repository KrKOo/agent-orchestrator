// TaskView: the task chat (manager messages, event notices, ask_user buttons) plus a live "Manager
// working" strip and a side pane with the task's child runs, settings and actions.
import { TASK_MESSAGE_MAX, type TaskMessage, type TaskStreamItem } from "@orch/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, CheckCircle2, RotateCcw, SendHorizonal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, errorMessage } from "../api";
import { LongText } from "../components/LongText";
import { useToast } from "../components/Toast";
import { applyTaskItems, childRuns, childRunsOf, initialTaskState, managerTail, type TaskState } from "../taskState";
import {
  Collapsible,
  EmptyState,
  PageHeader,
  RelativeTime,
  Skeleton,
  StatusChip,
  formatTime,
  usePageTitle,
} from "../ui";
import { useTaskStream } from "../ws";

/** Max characters of the "Manager working" strip. */
const TAIL_CHARS = 400;

/** One chat message; `event` ones render compact and collapsible. */
function ChatMessage({ message }: { message: TaskMessage }) {
  const runLink = message.runId && (
    <Link to={`/runs/${message.runId}`} className="task-msg-run small">
      run {message.runId.slice(-8)}
    </Link>
  );
  const meta = (
    <>
      <strong className="task-msg-role">{message.role}</strong>
      <time dateTime={new Date(message.ts).toISOString()}>{formatTime(message.ts)}</time>
    </>
  );
  if (message.role === "event") {
    // The run link sits beside the Collapsible: its summary is a <button>, which must not contain a link
    // (and a click on the link would toggle the panel).
    return (
      <div className={`task-msg task-msg-event ${message.event ?? ""}`}>
        <Collapsible summary={<span className="task-msg-head muted small">{meta}</span>}>
          <div className="task-msg-text">{message.text}</div>
        </Collapsible>
        {runLink}
      </div>
    );
  }
  return (
    <div className={`task-msg task-msg-${message.role}`}>
      <span className="task-msg-head muted small">
        {meta}
        {runLink}
      </span>
      {message.choice && <div className="small muted">picked “{message.choice}”</div>}
      {/* Manager replies are agent output: rendered as Markdown like a run transcript's text. */}
      {message.role === "manager" ? (
        <LongText className="task-msg-text" text={message.text} markdown />
      ) : (
        <div className="task-msg-text">{message.text}</div>
      )}
    </div>
  );
}

/** Answer buttons of a manager `ask_user`; picking posts the choice answer. */
function ChoiceButtons({
  message,
  answered,
  onPick,
  disabled,
}: {
  message: TaskMessage;
  /** A user message already picked an answer (or the task moved on): the buttons stay as history. */
  answered: boolean;
  onPick: (choice: string) => void;
  disabled: boolean;
}) {
  if (message.role !== "manager" || !message.choices || message.answerTo !== undefined) return null;
  return (
    <div className="row gap wrap task-choices">
      {message.choices.map((c) => (
        <button key={c.id} type="button" className="btn small" disabled={answered || disabled} onClick={() => onPick(c.id)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

function ManagerStrip({ state, runId }: { state: TaskState; runId: string | null }) {
  const tail = managerTail(state, TAIL_CHARS);
  // Live while the task's current manager run holds a runner; the tail text may still be empty.
  const status = runId !== null ? state.runs[runId]?.status : undefined;
  const live = status === "assigned" || status === "running";
  if (!live) return null;
  return (
    <div className="task-working small muted">
      <span className="dot dot-on" aria-hidden />
      <strong>Manager working</strong>
      {tail && <span className="task-working-tail">{tail}</span>}
      {runId && (
        <Link to={`/runs/${runId}`} className="task-working-link">
          open run
        </Link>
      )}
    </div>
  );
}

function TaskViewInner({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => api.getTask(taskId) });
  const [state, setState] = useState<TaskState>(initialTaskState);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Whether the chat log is scrolled to (near) its end; only then do new messages scroll it. */
  const atBottom = useRef(true);

  const onItems = useCallback((items: TaskStreamItem[]) => {
    setState((prev) => applyTaskItems(prev, items));
  }, []);
  const connected = useTaskStream(taskId, onItems);

  // A batch touching the task row also refreshes the REST cache other pages read (e.g. the nav badge).
  useEffect(() => {
    if (state.task === null) return;
    qc.setQueryData(["task", taskId], {
      task: state.task,
      messages: state.messages.length > 0 ? state.messages : detail.data?.messages ?? [],
      runs: childRuns(state),
    });
  }, [state.task, qc, taskId]);

  // Keep the chat scrolled to the newest message while the user is at (or near) the bottom.
  useEffect(() => {
    const el = bottomRef.current?.parentElement;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.managerTranscript?.items.length]);

  const post = useMutation({
    mutationFn: (body: { text: string } | { choice: string; answerTo: number }) =>
      api.postTaskMessage(taskId, body),
    onSettled: () => {
      setSending(false);
      void detail.refetch();
    },
    onError: (err) => toast(`Send failed: ${errorMessage(err)}`, { kind: "error" }),
  });

  const setStatus = useMutation({
    mutationFn: (status: "active" | "done" | "archived") => api.updateTask(taskId, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      void detail.refetch();
    },
    onError: (err) => toast(errorMessage(err), { kind: "error" }),
  });

  const send = () => {
    const body = text.trim();
    if (body === "" || sending) return;
    setSending(true);
    // Follow the reply. The text is cleared only once the server took it, so a failed send can be retried;
    // anything typed meanwhile stays.
    atBottom.current = true;
    post.mutate({ text: body }, { onSuccess: () => setText((cur) => (cur.trim() === body ? "" : cur)) });
  };

  usePageTitle(state.task ? `Task · ${state.task.title}` : "Task");

  if (detail.isPending) {
    return (
      <div className="page">
        <Skeleton rows={5} />
      </div>
    );
  }
  if (detail.error && !detail.data) {
    return (
      <div className="page">
        <EmptyState title="Task not available">{errorMessage(detail.error)}</EmptyState>
      </div>
    );
  }

  const task = state.task ?? detail.data!.task;
  // The stream's backlog carries the whole chat; fall back to REST while the socket connects.
  const messages = state.messages.length > 0 ? state.messages : detail.data!.messages;
  // Same for the child runs: the stream upserts full rows, REST's list is the offline fallback.
  const runs = Object.keys(state.runs).length > 0 ? childRuns(state) : childRunsOf(detail.data!.runs);
  const managerRunId = task.managerRunId;
  const needsInput = task.status === "needs_input";
  // The newest ask_user question (with its choices).
  const lastQuestion = [...messages].reverse().find((m) => m.role === "manager" && m.answerTo === undefined && m.choices !== undefined);
  /**
   * The only question whose buttons still answer: the newest one, while no user message follows it (a pick or a
   * free-text reply answers it). Older questions keep their buttons as history, disabled: picking there would send
   * the manager an outdated answer.
   */
  const openQuestionSeq =
    lastQuestion && !messages.some((m) => m.role === "user" && m.seq > lastQuestion.seq) ? lastQuestion.seq : null;

  return (
    <div className="task-view">
      <header className="task-header">
        <PageHeader
          title={task.title}
          subtitle={
            <>
              <StatusChip status={task.status} /> <RelativeTime ts={task.updatedAt} />
              {needsInput && <span className="muted"> — the manager is waiting for you</span>}
            </>
          }
          actions={
            <>
              {task.status !== "done" && task.status !== "archived" && (
                <button type="button" className="btn" disabled={setStatus.isPending} onClick={() => setStatus.mutate("done")}>
                  <CheckCircle2 size={14} aria-hidden />
                  Mark done
                </button>
              )}
              {(task.status === "done" || task.status === "archived") && (
                <button type="button" className="btn" disabled={setStatus.isPending} onClick={() => setStatus.mutate("active")}>
                  <RotateCcw size={14} aria-hidden />
                  Reopen
                </button>
              )}
              {task.status !== "archived" && (
                <button type="button" className="btn danger" disabled={setStatus.isPending} onClick={() => setStatus.mutate("archived")}>
                  <Archive size={14} aria-hidden />
                  Archive
                </button>
              )}
            </>
          }
        />
      </header>
      <div className="task-body">
        <div className="task-chat">
          <div
            className="task-log"
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {messages.map((m) => (
              <div key={m.seq}>
                <ChatMessage message={m} />
                <ChoiceButtons
                  message={m}
                  answered={m.seq !== openQuestionSeq}
                  disabled={sending || post.isPending}
                  onPick={(choice) => post.mutate({ choice, answerTo: m.seq })}
                />
              </div>
            ))}
            <ManagerStrip state={state} runId={managerRunId} />
            <div ref={bottomRef} />
          </div>
          <div className="task-composer">
            <textarea
              aria-label="Message the task"
              rows={3}
              // An archived task's messages endpoint 409s, so its composer is read-only.
              disabled={task.status === "archived"}
              placeholder={
                task.status === "archived"
                  ? "This task is archived — reopen it to continue."
                  : needsInput
                    ? "Answer the manager, or send a new instruction…"
                    : "Message the manager…"
              }
              value={text}
              maxLength={TASK_MESSAGE_MAX}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // An IME's Enter accepts its candidate; it must not send the half-composed message.
                if (e.nativeEvent.isComposing) return;
                // Enter sends (chat convention); Shift+Enter is a newline.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <div className="row gap">
              <button
                type="button"
                className="btn primary"
                disabled={task.status === "archived" || text.trim() === "" || sending}
                onClick={send}
              >
                <SendHorizonal size={14} aria-hidden />
                {sending ? "Sending…" : "Send"}
              </button>
              <span className="muted small">Enter sends · Shift+Enter for a new line</span>
              {!connected && <span className="muted small">reconnecting…</span>}
            </div>
          </div>
        </div>
        <aside className="task-side" aria-label="Task details">
          <section>
            <h4>Runs</h4>
            {runs.length === 0 ? (
              <p className="muted small">No runs yet.</p>
            ) : (
              <ul className="task-run-list">
                {runs.map((r) => (
                  <li key={r.id}>
                    <Link to={`/runs/${r.id}`}>
                      <StatusChip status={r.status} /> {r.name ?? r.flowName}
                    </Link>
                    {r.interventionHandler === "manager" && <span className="tag">handled by manager</span>}
                    {r.error && <div className="cell-error small" title={r.error}>{r.error}</div>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h4>Settings</h4>
            <dl className="task-facts small">
              <dt>Interventions</dt>
              <dd>{task.settings.interventions === "manager" ? "handled by the manager" : "you answer"}</dd>
              <dt>Merge mode</dt>
              <dd>{task.settings.merge}</dd>
              <dt>Auto-merge final PR</dt>
              <dd>{task.settings.autoMergeFinal ? "yes" : "no"}</dd>
              <dt>Max parallel runs</dt>
              <dd>{task.settings.maxParallelRuns}</dd>
              <dt>Manager model</dt>
              <dd className="mono">{task.settings.managerModels.model}</dd>
            </dl>
          </section>
          <section>
            <h4>Repositories</h4>
            <ul className="task-facts small">
              {task.settings.repos.map((repo) => {
                const integration = task.integration[repo.github];
                return (
                  <li key={repo.github}>
                    <span className="mono">{repo.github}</span>
                    {integration && (
                      <div className="small muted">
                        integration <span className="mono">{integration.branch}</span>
                        {integration.finalPr && (
                          <>
                            {" "}
                            · final{" "}
                            <a href={integration.finalPr.url} target="_blank" rel="noreferrer">
                              #{integration.finalPr.number}
                            </a>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          {lastQuestion && (
            <section className="muted small">
              Last question: “{lastQuestion.text}”
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

export function TaskView() {
  const { id = "" } = useParams();
  return <TaskViewInner key={id} taskId={id} />;
}
