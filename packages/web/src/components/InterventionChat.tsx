import type { InterventionAction, InterventionSession } from "@orch/protocol";
import { useState } from "react";
import Markdown from "react-markdown";
import { api, errorMessage } from "../api";
import type { InterventionView } from "../runState";
import { Collapsible } from "../ui";

/** Session the chat targets: the user's pick if still offered, else the runner's preselection, else the first. */
export function chatSession(request: InterventionView, picked: string | undefined): InterventionSession | undefined {
  const { sessions } = request;
  return sessions.find((s) => s.id === picked) ?? sessions.find((s) => s.id === request.session) ?? sessions[0];
}

/** The chat's opening message: the session's result at the moment the run paused, before any user message. */
export function InterventionStart({ session }: { session: InterventionSession }) {
  return (
    <div className="intervention-start">
      <div className="muted small">
        Result of <strong>{session.label}</strong> when the run paused
      </div>
      {session.output ? (
        <div className="markdown">
          <Markdown>{session.output}</Markdown>
        </div>
      ) : (
        <p className="muted">No text.</p>
      )}
    </div>
  );
}

/**
 * Chat input of a waiting intervention step, docked below the scrolling transcript: send messages
 * (slash commands included) to one of the run's sessions, continue the run, or cancel the step.
 */
export function InterventionComposer({
  runId,
  stepId,
  request,
  session,
  awaiting,
  onPick,
  onSubmitted,
}: {
  runId: string;
  stepId: string;
  /** Latest request of this step; it carries the session list. */
  request: InterventionView;
  session: InterventionSession | undefined;
  /** The request is open (no reply is streaming and it was not answered from here). */
  awaiting: boolean;
  onPick: (sessionId: string) => void;
  onSubmitted: (requestId: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = awaiting && !busy;
  const canSend = enabled && session !== undefined && text.trim() !== "";

  const respond = async (action: InterventionAction) => {
    setBusy(true);
    setError(null);
    try {
      await api.respondIntervention(runId, request.requestId, {
        stepId,
        action,
        ...(action !== "cancel" && session ? { session: session.id } : {}),
        ...(action === "message" ? { text } : {}),
      });
      if (action === "message") setText("");
      onSubmitted(request.requestId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="intervention-composer">
      {request.error && <p className="error">{request.error}</p>}
      {error && <p className="error">{error}</p>}
      {request.sessions.length === 0 ? (
        <p className="muted">No agent session has run yet; continue or cancel.</p>
      ) : (
        <>
          <div className="row gap">
            <label htmlFor="intervention-session">Session</label>
            <select id="intervention-session" value={session?.id} disabled={!enabled} onChange={(e) => onPick(e.target.value)}>
              {request.sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            {!awaiting && <span className="muted small">Waiting for the reply…</span>}
          </div>
          <textarea
            aria-label="Message"
            rows={3}
            value={text}
            disabled={!enabled}
            placeholder="Message this session — e.g. corrections, more context, or a slash command like /review. Ctrl+Enter sends."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canSend) {
                e.preventDefault();
                void respond("message");
              }
            }}
          />
        </>
      )}
      {session && (
        <Collapsible
          key={session.id}
          className="intervention-result"
          summary={
            <span className="intervention-result-summary">
              <span className="muted">Continue passes on the latest reply of</span> <strong>{session.label}</strong>
              <span className="muted">:</span>{" "}
              <span className="intervention-result-preview">
                {session.output.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") || "(no text yet)"}
              </span>
            </span>
          }
        >
          {session.output ? (
            <div className="markdown">
              <Markdown>{session.output}</Markdown>
            </div>
          ) : (
            <p className="muted">No text yet.</p>
          )}
          <small className="muted">
            Available to later steps as <code>{`{{steps.${stepId}.output}}`}</code>.
          </small>
        </Collapsible>
      )}
      <div className="row gap">
        <button type="button" className="btn danger" disabled={!enabled} onClick={() => respond("cancel")}>
          Cancel step
        </button>
        <span className="grow" />
        {request.sessions.length > 0 && (
          <button type="button" className="btn" disabled={!canSend} onClick={() => respond("message")}>
            Send
          </button>
        )}
        <button type="button" className="btn primary" disabled={!enabled} onClick={() => respond("continue")}>
          Continue run
        </button>
      </div>
    </div>
  );
}
