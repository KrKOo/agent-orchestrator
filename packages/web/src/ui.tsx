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

/** One GitHub issue/PR resolved from the run's inputs, for runs the server has no `github` row for. */
export interface GithubRef {
  kind: "issue" | "pull_request";
  repo: string;
  number: number;
  title: string;
  url: string;
}

/**
 * Pairs the flow definition's `github_issue`/`github_pull_request` inputs with the resolved run inputs.
 * Purely derived client-side: the server stores GitHub inputs opaquely in `run.inputs`.
 */
export function githubRefsOf(run: { definition: { inputs: { key: string; type: string }[] }; inputs: Record<string, unknown> }): GithubRef[] {
  const refs: GithubRef[] = [];
  for (const def of run.definition.inputs) {
    if (def.type !== "github_issue" && def.type !== "github_pull_request") continue;
    const value = run.inputs[def.key];
    if (typeof value !== "object" || value === null) continue;
    const v = value as { repo?: unknown; number?: unknown; title?: unknown; url?: unknown };
    if (typeof v.repo !== "string" || typeof v.number !== "number" || typeof v.title !== "string" || typeof v.url !== "string") continue;
    refs.push({ kind: def.type as "issue" | "pull_request", repo: v.repo, number: v.number, title: v.title, url: v.url });
  }
  return refs;
}

/** `owner/name#123 — title` linked to the issue or pull request. */
export function IssueLink({ githubRef: r }: { githubRef: GithubRef }) {
  return (
    <a className="pr-link" href={r.url} target="_blank" rel="noreferrer" title={r.title}>
      {r.repo}#{r.number} — {r.title}
    </a>
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
