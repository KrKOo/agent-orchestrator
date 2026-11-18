import type { InterventionAction, InterventionSession, Step } from "@orch/protocol";
import { useState } from "react";
import { api, errorMessage } from "../api";
import type { InterventionView } from "../runState";
import { Collapsible } from "../ui";
import { LongText } from "./LongText";

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
        <LongText text={session.output} markdown />
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
  /** Definition of the run, to spell out what a `repeat` answers to (falls back to the step id). */
  steps,
  awaiting,
  /** Name of the step being chatted with, shown when the composer docks for a non-selected step. */
  stepName,
  onPick,
  onSubmitted,
}: {
  runId: string;
  stepId: string;
  /** Latest request of this step; it carries the session list. */
  request: InterventionView;
  session: InterventionSession | undefined;
  /** The run's flow definition, only for naming the `repeat` target. */
  steps: Step[];
  /** The request is open (no reply is streaming and it was not answered from here). */
  awaiting: boolean;
  stepName?: string;
  onPick: (sessionId: string) => void;
  onSubmitted: (requestId: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = awaiting && !busy;
  const canSend = enabled && session !== undefined && text.trim() !== "";

  const respond = async (action: InterventionAction, choice?: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.respondIntervention(runId, request.requestId, {
        stepId,
        action,
        ...(action !== "cancel" && session ? { session: session.id } : {}),
        ...(action === "message" ? { text } : {}),
        // Only a gate with choices takes a choice; the server rejects it elsewhere.
        ...(action === "continue" && choice ? { choice } : {}),
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
      {stepName && (
        <div className="composer-step-label small muted">
          step <strong>{stepName}</strong>
        </div>
      )}
      {request.error && <p className="error">{request.error}</p>}
      {error && <p className="error">{error}</p>}
      {request.sessions.length === 0 ? (
        <p className="muted">No agent session has run yet; {request.choices ? "pick an option" : "continue"} or cancel.</p>
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
              {request.choices ? (
                <>
                  <span className="muted">The chosen option and the latest reply of</span> <strong>{session.label}</strong>
                  <span className="muted">pass on:</span>{" "}
                </>
              ) : (
                <>
                  <span className="muted">Continue passes on the latest reply of</span> <strong>{session.label}</strong>
                  <span className="muted">:</span>{" "}
                </>
              )}
              <span className="intervention-result-preview">
                {/* First non-blank line, found without splitting a possibly huge output. */}
                {/\S.*/.exec(session.output)?.[0].replace(/^#+\s*/, "") || "(no text yet)"}
              </span>
            </span>
          }
        >
          {session.output ? (
            <LongText text={session.output} markdown />
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
        {request.repeat && (
          <button
            type="button"
            className="btn"
            disabled={!enabled}
            title={`Re-run the flow from "${repeatTarget(steps, request.repeat.toStepId)}" for iteration ${request.repeat.iteration} of ${request.repeat.maxIterations}`}
            onClick={() => respond("repeat")}
          >
            Repeat from {repeatTarget(steps, request.repeat.toStepId)} ({request.repeat.iteration}/{request.repeat.maxIterations})
          </button>
        )}
        {request.choices ? (
          // One primary button per choice replaces "Continue": the picked id branches the run.
          request.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn primary"
              disabled={!enabled}
              title={`Pick "${c.label}"; the run branches on this choice`}
              onClick={() => respond("continue", c.id)}
            >
              {c.label}
            </button>
          ))
        ) : (
          <button type="button" className="btn primary" disabled={!enabled} onClick={() => respond("continue")}>
            Continue run
          </button>
        )}
      </div>
    </div>
  );
}

/** Name of the step a `repeat` jumps back to, or its id if the definition no longer lists it. */
function repeatTarget(steps: Step[], toStepId: string): string {
  return steps.find((s) => s.id === toStepId)?.name ?? toStepId;
}
