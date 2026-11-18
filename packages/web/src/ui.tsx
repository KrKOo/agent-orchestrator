// Small shared presentational helpers.
import { type RunGitHubInfo, unwrapUntrustedText } from "@orch/protocol";
import { ChevronDown, ChevronRight, Copy, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useToast } from "./components/Toast";

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
    refs.push({
      kind: def.type === "github_issue" ? "issue" : "pull_request",
      repo: v.repo,
      number: v.number,
      // PR titles are stored wrapped as untrusted agent input; show the bare title.
      title: unwrapUntrustedText(v.title),
      url: v.url,
    });
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

/**
 * Coarse "how long ago": `just now` under 10s, then s/m/h/d buckets (floored), and the locale date from 7 days on.
 * Future timestamps (clock skew between server and browser) read as `just now`.
 */
export function formatRelative(ts: number, now: number): string {
  const secs = Math.floor((now - ts) / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// One shared ticker for every mounted clock-driven label, rather than an interval per row.
const TICK_MS = 5000;
const tickListeners = new Set<() => void>();
let tickNow = Date.now();
let tickTimer: ReturnType<typeof setInterval> | null = null;
function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);
  if (!tickTimer) {
    // The clock froze while nothing was subscribed; React re-reads the snapshot after subscribing.
    tickNow = Date.now();
    tickTimer = setInterval(() => {
      tickNow = Date.now();
      for (const l of tickListeners) l();
    }, TICK_MS);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}
/** Wall clock that re-renders the caller every few seconds. */
export function useNow(): number {
  return useSyncExternalStore(subscribeTick, () => tickNow);
}

/** "3m ago", ticking; the absolute time is the hover title. */
export function RelativeTime({ ts }: { ts: number | null | undefined }) {
  const now = useNow();
  if (!ts) return <span className="muted">—</span>;
  return (
    <time dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString()}>
      {formatRelative(ts, now)}
    </time>
  );
}

export function formatDuration(from: number | null, to: number | null): string {
  if (!from) return "—";
  const secs = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m ${secs % 60}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Copies `value` to the clipboard; confirms (or reports failure) with a toast. */
export function CopyButton({ value, title, label = "Copy" }: { value: string; title?: string; label?: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      // `navigator.clipboard` is missing outside secure contexts; the throw lands in the catch.
      await navigator.clipboard.writeText(value);
      toast("Copied to clipboard", { kind: "success" });
    } catch {
      toast("Copy failed: clipboard unavailable", { kind: "error" });
    }
  };
  return (
    <button type="button" className="btn small" title={title} aria-label={title} onClick={() => void copy()}>
      <Copy size={13} aria-hidden />
      {label}
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
      <button type="button" className="collapsible-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="caret" aria-hidden>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        {summary}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

/** Page title row: heading, optional subtitle line, and right-aligned actions. */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h2>{title}</h2>
        {subtitle && <div className="page-subtitle muted">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

/** Centered placeholder for an empty list or missing page, with an optional call to action. */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && (
        <div className="empty-state-icon" aria-hidden>
          {icon}
        </div>
      )}
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

/** Placeholder bars while a query loads (announced once as "Loading"). */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}

/** Visually hidden live region: announces `message` changes to screen readers. */
export function LiveAnnouncer({ message }: { message: string }) {
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}

const APP_TITLE = "Agent Orchestrator";
/** `document.title` for a route part (null: none) and the number of runs waiting for the user. */
export function documentTitle(page: string | null, attention: number): string {
  const base = page ? `${page} — ${APP_TITLE}` : APP_TITLE;
  return attention > 0 ? `(${attention}) ${base}` : base;
}
const titleState = { page: null as string | null, attention: 0 };
function applyTitle(): void {
  document.title = documentTitle(titleState.page, titleState.attention);
}
/** Sets the route's part of `document.title` while mounted. */
export function usePageTitle(page: string | null): void {
  useEffect(() => {
    titleState.page = page;
    applyTitle();
    return () => {
      if (titleState.page === page) titleState.page = null;
      applyTitle();
    };
  }, [page]);
}
/** The `(n)` prefix: runs waiting for the user. */
export function setAttentionTitleCount(count: number): void {
  titleState.attention = count;
  applyTitle();
}

/** Segmented tab bar (WAI-ARIA tabs: arrow keys move between tabs). Panels are rendered by the caller. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  // Roving tabindex: the selected tab, or the first one when `value` matches none (e.g. a custom filter),
  // so the tablist always stays reachable by keyboard.
  const focusId = tabs.some((t) => t.id === value) ? value : tabs[0]?.id;
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.id === focusId);
    const next = tabs[(idx + step + tabs.length) % tabs.length]!;
    onChange(next.id);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          data-tab={t.id}
          aria-selected={t.id === value}
          tabIndex={t.id === focusId ? 0 : -1}
          className={t.id === value ? "active" : ""}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Open `useDismiss` layers, oldest first. Escape closes only the newest, so one press peels one layer. */
const dismissStack: object[] = [];

/**
 * Calls `close` on a pointer-down outside every `refs` element, or on Escape when this is the topmost open
 * layer; for popovers, menus, drawers. `refs` must be a stable array (the effect re-subscribes when it changes).
 */
export function useDismiss(open: boolean, close: () => void, refs: readonly RefObject<HTMLElement | null>[]): void {
  // Read through a ref so an inline `close` doesn't re-subscribe each render, which would re-push the
  // layer and wrongly make it the newest.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const layer = {};
    dismissStack.push(layer);
    const onPointer = (e: PointerEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      // Every layer's listener sees the event, so only the newest acts. It also stops the remaining
      // listeners: React may flush the close (and pop this layer) between listeners, which would let
      // the next layer down match too.
      if (e.key !== "Escape" || dismissStack.at(-1) !== layer) return;
      e.stopImmediatePropagation();
      closeRef.current();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      dismissStack.splice(dismissStack.indexOf(layer), 1);
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, refs]);
}

/** Whether `query` (a CSS media query) currently matches; re-renders when that changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/**
 * A trigger button plus a floating panel (menu or popover). `children` gets `close`, so menu items can dismiss it.
 * Closes on outside click and Escape; Escape returns focus to the trigger.
 */
export function Popover({
  label,
  button,
  buttonClassName = "icon-btn",
  align = "end",
  placement = "below",
  className,
  children,
}: {
  /** Accessible name of the trigger (it is often icon-only). */
  label: string;
  button: ReactNode;
  buttonClassName?: string;
  align?: "start" | "end";
  placement?: "below" | "above";
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const refs = useRef([rootRef]).current;
  useDismiss(open, close, refs);
  return (
    <div className="popover-root" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={buttonClassName}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen(!open)}
      >
        {button}
      </button>
      {open && (
        <div id={panelId} className={`popover popover-${align} popover-${placement} ${className ?? ""}`}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

let scrollLocks = 0;

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Whatever opened the dialog, read during the first render: React 19 focuses an `autoFocus` child during
  // commit, before the effect below runs, so document.activeElement there is already inside the dialog.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  // Initial focus target, kept for StrictMode's effect re-run (its cleanup has moved focus back to the opener).
  const initialFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const active = document.activeElement;
    // An `autoFocus` child already holds focus; otherwise the first form field, else the first focusable control.
    initialFocusRef.current ??=
      active instanceof HTMLElement && dialog.contains(active)
        ? active
        : (dialog.querySelector<HTMLElement>(".modal-body :is(input, select, textarea):not(:disabled)") ??
          dialog.querySelector<HTMLElement>(`.modal-body :is(${FOCUSABLE}), .modal-footer :is(${FOCUSABLE})`) ??
          dialog);
    initialFocusRef.current.focus();
    if (scrollLocks++ === 0) document.body.style.overflow = "hidden";
    return () => {
      if (--scrollLocks === 0) document.body.style.overflow = "";
      // Restore focus to whatever opened the dialog, if it is still on the page.
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && onCloseRef.current) {
      // Handled on the dialog itself (not window) so a stacked dialog closes alone.
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...dialogRef.current!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstItem = items[0]!;
    const lastItem = items.at(-1)!;
    if (e.shiftKey && (document.activeElement === firstItem || document.activeElement === dialogRef.current)) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div
        ref={dialogRef}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
              <X size={18} aria-hidden />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

/** Yes/no dialog; Escape, backdrop and the close button all mean "cancel". */
export function ConfirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger, onResult }: ConfirmOptions & { onResult: (ok: boolean) => void }) {
  return (
    <Modal
      title={title}
      onClose={() => onResult(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => onResult(false)}>
            {cancelLabel}
          </button>
          <button type="button" className={`btn ${danger ? "danger solid" : "primary"}`} autoFocus onClick={() => onResult(true)}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {body}
    </Modal>
  );
}

/**
 * Async replacement for `window.confirm`: `const [confirm, dialog] = useConfirm()`, render `dialog`, then
 * `if (await confirm({ title: "Delete?" })) …`.
 */
export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback((opts: ConfirmOptions) => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setPending({ ...opts, resolve });
    return promise;
  }, []);
  const dialog = pending ? (
    <ConfirmDialog
      {...pending}
      onResult={(ok) => {
        pending.resolve(ok);
        setPending(null);
      }}
    />
  ) : null;
  return [confirm, dialog];
}
