import type { ElicitationAction } from "@orch/protocol";
import { useState } from "react";
import { api, errorMessage } from "../api";
import type { ElicitationView } from "../runState";
import { Modal, toJson } from "../ui";

interface PropSchema {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  enumNames?: string[];
  oneOf?: { const?: unknown; title?: string }[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

type FieldKind = "text" | "select" | "checkbox" | "number" | "unsupported";

function fieldKind(p: PropSchema): FieldKind {
  if (p.type === "string") {
    if (Array.isArray(p.enum) || (Array.isArray(p.oneOf) && p.oneOf.every((o) => typeof o.const === "string"))) {
      return "select";
    }
    return "text";
  }
  if (p.type === "boolean") return "checkbox";
  if (p.type === "number" || p.type === "integer") return "number";
  return "unsupported";
}

function initialValue(p: PropSchema, kind: FieldKind): unknown {
  if (p.default !== undefined) return p.default;
  if (kind === "checkbox") return false;
  if (kind === "select") return p.enum?.[0] ?? p.oneOf?.[0]?.const ?? "";
  return "";
}

/** Form for an ACP/MCP elicitation request; only flat string/enum/boolean/number schemas can be accepted. */
export function ElicitationDialog({
  runId,
  request,
  onSubmitted,
}: {
  runId: string;
  request: ElicitationView;
  onSubmitted: (requestId: string) => void;
}) {
  const schema = (request.requestedSchema ?? {}) as { properties?: Record<string, PropSchema>; required?: string[] };
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const kinds = Object.fromEntries(props.map(([k, p]) => [k, fieldKind(p)]));
  const supported = props.every(([k]) => kinds[k] !== "unsupported");
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(props.filter(([k]) => kinds[k] !== "unsupported").map(([k, p]) => [k, initialValue(p, kinds[k]!)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = props.filter(([k]) => required.has(k) && kinds[k] !== "checkbox" && (values[k] === "" || values[k] === undefined));

  const respond = async (action: ElicitationAction) => {
    setBusy(true);
    setError(null);
    try {
      let content: Record<string, unknown> | undefined;
      if (action === "accept") {
        content = {};
        for (const [k] of props) {
          const v = values[k];
          if (v === "" && !required.has(k)) continue;
          content[k] = kinds[k] === "number" ? Number(v) : v;
        }
      }
      await api.respondElicitation(runId, request.requestId, action, content);
      onSubmitted(request.requestId);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Input requested"
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => respond("decline")}>
            Decline
          </button>
          {supported && (
            <button
              type="button"
              className="btn primary"
              disabled={busy || missing.length > 0}
              onClick={() => respond("accept")}
            >
              Submit
            </button>
          )}
        </>
      }
    >
      <p className="pre-wrap">{request.message}</p>
      {props.map(([key, p]) => {
        const kind = kinds[key]!;
        const label = (
          <span>
            {p.title ?? key}
            {required.has(key) && <span className="muted"> *</span>}
          </span>
        );
        const set = (v: unknown) => setValues({ ...values, [key]: v });
        if (kind === "checkbox") {
          return (
            <label key={key} className="check">
              <input type="checkbox" checked={values[key] === true} onChange={(e) => set(e.target.checked)} />
              {p.title ?? key}
              {p.description && <small className="muted"> — {p.description}</small>}
            </label>
          );
        }
        return (
          <label key={key} className="field">
            {label}
            {kind === "text" && <input value={String(values[key] ?? "")} onChange={(e) => set(e.target.value)} />}
            {kind === "number" && (
              <input
                type="number"
                min={p.minimum}
                max={p.maximum}
                step={p.type === "integer" ? 1 : "any"}
                value={String(values[key] ?? "")}
                onChange={(e) => set(e.target.value)}
              />
            )}
            {kind === "select" && (
              <select value={String(values[key] ?? "")} onChange={(e) => set(e.target.value)}>
                {p.enum
                  ? p.enum.map((v, i) => (
                      <option key={String(v)} value={String(v)}>
                        {p.enumNames?.[i] ?? String(v)}
                      </option>
                    ))
                  : p.oneOf?.map((o) => (
                      <option key={String(o.const)} value={String(o.const)}>
                        {o.title ?? String(o.const)}
                      </option>
                    ))}
              </select>
            )}
            {kind === "unsupported" && (
              <div className="unsupported">
                <pre>{toJson(p)}</pre>
                <small className="error">Unsupported field type</small>
              </div>
            )}
            {p.description && <small className="muted">{p.description}</small>}
          </label>
        );
      })}
      {error && <p className="error">{error}</p>}
    </Modal>
  );
}
