// Transient mutation feedback ("Flow saved", "Run cancelled", "Copied"), optionally with one action (Undo).
import { X } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";

export interface ToastOptions {
  kind?: "info" | "success" | "error";
  /** One inline action; clicking it runs `onAction` and dismisses the toast. */
  action?: { label: string; onAction: () => void };
  /** Auto-dismiss delay; actionable toasts stay longer so there is time to reach the button. */
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

type ShowToast = (message: string, opts?: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

const TOAST_MS = 3500;
const ACTION_TOAST_MS = 8000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback<ShowToast>(
    (message, opts = {}) => {
      const id = ++nextId.current;
      // Newest last; cap the stack so a burst of copies can't cover the page.
      setToasts((list) => [...list.slice(-3), { id, message, ...opts }]);
      setTimeout(() => dismiss(id), opts.durationMs ?? (opts.action ? ACTION_TOAST_MS : TOAST_MS));
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Always mounted so screen readers pick up insertions into an existing live region. */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind ?? "info"}`}>
            <span className="grow">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="btn small ghost"
                onClick={() => {
                  t.action!.onAction();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Shows a toast; a no-op outside `ToastProvider` (keeps components usable in isolation). */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  return useMemo(() => show ?? (() => {}), [show]);
}
