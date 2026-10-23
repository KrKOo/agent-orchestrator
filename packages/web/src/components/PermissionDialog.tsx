import { useState } from "react";
import { api, errorMessage } from "../api";
import type { PermissionView } from "../runState";
import { Modal, toJson } from "../ui";

/** Approve/deny an ACP `session/request_permission` relayed through the server. */
export function PermissionDialog({
  runId,
  request,
  onSubmitted,
}: {
  runId: string;
  request: PermissionView;
  onSubmitted: (requestId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tool = (request.toolCall ?? {}) as { title?: string; kind?: string; rawInput?: unknown };

  const respond = async (optionId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.respondPermission(runId, request.requestId, optionId);
      onSubmitted(request.requestId);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Permission requested"
      footer={
        <>
          <button type="button" className="btn danger" disabled={busy} onClick={() => respond(null)}>
            Deny
          </button>
          {request.options.map((o) => (
            <button
              key={o.optionId}
              type="button"
              className={`btn ${o.kind.startsWith("allow") ? "primary" : o.kind.startsWith("reject") ? "danger" : ""}`}
              disabled={busy}
              onClick={() => respond(o.optionId)}
            >
              {o.name}
            </button>
          ))}
        </>
      }
    >
      <p>
        The agent wants to run{tool.kind ? <span className="tag">{tool.kind}</span> : null}{" "}
        <strong>{tool.title ?? "a tool"}</strong>
        {request.stepId && (
          <>
            {" "}
            in step <span className="mono">{request.stepId}</span>
          </>
        )}
        .
      </p>
      {tool.rawInput !== undefined && <pre className="scroll-pre">{toJson(tool.rawInput)}</pre>}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
