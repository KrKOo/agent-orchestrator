// Shared shell of the run pane's docked request panels (permission, elicitation): one fixed slot at
// the bottom, under the transcript, which stays scrollable while a request waits. There is no close
// button: the run is paused on this request, so the panel only leaves once it is answered.
import { TriangleExclamationPoint } from "lucide-react";
import type { ReactNode } from "react";

export function RequestPanel({
  title,
  stepName,
  error,
  children,
}: {
  title: ReactNode;
  /** Name of the step that is asking, shown when the panel outlives the selected step. */
  stepName?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <section className="request-panel" aria-label={typeof title === "string" ? title : "Pending request"}>
      <div className="request-panel-head">
        <TriangleExclamationPoint size={16} aria-hidden />
        <strong>{title}</strong>
        {stepName && <span className="tag">step {stepName}</span>}
      </div>
      <div className="request-panel-body">{children}</div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
