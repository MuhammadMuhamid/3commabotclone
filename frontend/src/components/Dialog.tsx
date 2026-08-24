import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** Everything that can hold keyboard focus inside the panel. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog that a keyboard and a screen reader can both operate.
 *
 * The dashboard's Partial Close overlay — which sells part of a real position —
 * was a bare `fixed inset-0` div. It had no `role`, so a screen reader
 * announced it as though the page had simply grown more content; no Escape
 * handler, so it could only be dismissed with a mouse; no focus management, so
 * a keyboard user tabbed through the dashboard behind it; and an unlabelled
 * icon button to close.
 *
 * This is the same contract the platform's `Modal` provides, kept as its own
 * component here because the two repositories stay separate and a shared UI
 * package would be a dependency between them that nothing else needs.
 */
export function Dialog({
  open, onClose, title, icon, children, footer, maxWidth = "max-w-sm",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  /**
   * The last thing focused outside any dialog.
   *
   * Reading `document.activeElement` when the open-effect runs is too late: a
   * field with `autoFocus` has already taken focus by then, so the dialog would
   * record one of its own children and, finding it removed on close, drop focus
   * to `<body>`. `closest` rather than this panel's ref, because the ref is
   * still null during the commit in which a child autofocuses itself.
   */
  const lastOutsideFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest || target.closest('[role="dialog"]')) return;
      lastOutsideFocus.current = target;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  const focusables = useCallback((): HTMLElement[] => {
    const panel = panelRef.current;
    if (!panel) return [];
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  }, []);

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement as HTMLElement | null;
    restoreTo.current =
      active && !panelRef.current?.contains(active) ? active : lastOutsideFocus.current;
    (focusables()[0] ?? panelRef.current)?.focus();
    return () => {
      // `isConnected` guards the case where the trigger was removed by whatever
      // the dialog just did — closing the trade its row belonged to.
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
  }, [open, focusables]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose, focusables]);

  // On a phone this is the difference between scrolling the form and scrolling
  // the dashboard out from under it.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/*
        Presentational: dismissing by clicking the backdrop is a convenience,
        and the labelled close button plus Escape are the accessible paths.
      */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative w-full ${maxWidth} max-h-[85vh] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6 shadow-2xl outline-none`}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <h2 id={titleId} className="text-sm font-semibold text-white">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            // 36px, so it is reachable with a thumb rather than only a pointer.
            className="-mr-1.5 flex h-9 w-9 items-center justify-center rounded text-[var(--color-muted)] transition-colors hover:text-white"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        {children}
        {footer}
      </div>
    </div>
  );
}
