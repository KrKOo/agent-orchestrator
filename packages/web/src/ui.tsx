// Small shared presentational helpers.
import type { RunGitHubInfo } from "@orch/protocol";
import { type ReactNode, useEffect, useState } from "react";

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip chip-${status}`}>{status.replaceAll("_", " ")}</span>;
}

/** `owner/name#123` linked to the pull request, plus the short head sha. */
export function PrLink({ github }: { github: RunGitHubInfo }) {
  return (
    <span className="pr-link">
      <a href={`https://github.com/${github.repo}/pull/${github.number}`} target="_blank" rel="noreferrer">
        {github.repo}#{github.number}
      </a>{" "}
      <span className="mono muted" title={github.headSha}>
        @{github.headSha.slice(0, 7)}
      </span>
    </span>
  );
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

export function formatDuration(from: number | null, to: number | null): string {
  if (!from) return "—";
  const secs = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Copies `value` to the clipboard; shows a short confirmation (or failure) inline. */
export function CopyButton({ value, title }: { value: string; title?: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    try {
      // `navigator.clipboard` is missing outside secure contexts; the throw lands in the catch.
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <button type="button" className="btn small" title={title} onClick={() => void copy()}>
      {copied === null ? "Copy" : copied ? "Copied" : "Copy failed"}
    </button>
  );
}

export function toJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Disclosure with a clickable summary line; content mounts only while open. */
export function Collapsible({
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`collapsible ${open ? "open" : ""} ${className ?? ""}`}>
      <button type="button" className="collapsible-summary" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        {summary}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h3>{title}</h3>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
