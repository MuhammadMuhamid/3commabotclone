import { type ReactNode, useEffect, useRef, useState, useCallback } from "react";
import { CheckCircle, AlertCircle, Info, X } from "lucide-react";

// ─── Button ────────────────────────────────────────────────────────────────

export function Btn({
  children,
  primary,
  danger,
  small,
  onClick,
  type = "button",
  disabled,
  loading,
  className = "",
}: {
  children: ReactNode;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}) {
  const base = small
    ? "px-3 py-1.5 rounded text-xs font-medium"
    : "px-4 py-2 rounded-lg text-sm font-medium";

  const variant = primary
    ? "bg-[var(--color-accent)] text-black hover:brightness-110 active:brightness-90"
    : danger
    ? "bg-[var(--color-danger)]/15 text-[var(--color-danger)] border border-[var(--color-danger)]/30 hover:bg-[var(--color-danger)]/25"
    : "border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-panel-2)] hover:border-[#3a4d66]";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={`${base} ${variant} transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 ${className}`}
    >
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
}

// ─── Toggle ────────────────────────────────────────────────────────────────

export function Toggle({
  on,
  onChange,
  label,
  desc,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  desc?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-3 cursor-pointer group">
      <div>
        <span className="text-sm font-medium text-[var(--color-text)] group-hover:text-white transition-colors">
          {label}
        </span>
        {desc && <p className="text-xs text-[var(--color-muted)] mt-0.5">{desc}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={`w-11 h-6 rounded-full relative transition-colors duration-200 flex-shrink-0 ${
          on ? "bg-[var(--color-accent)]" : "bg-[#2a3547]"
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200 ${
            on ? "left-5" : "left-0.5"
          }`}
        />
      </button>
    </label>
  );
}

// ─── Section ────────────────────────────────────────────────────────────────

export function Section({
  title,
  desc,
  children,
  side,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
  side?: ReactNode;
}) {
  return (
    <section className="mb-6 flex gap-6">
      <div className="w-44 shrink-0 pt-1">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {desc && <p className="text-xs text-[var(--color-muted)] mt-1 leading-relaxed">{desc}</p>}
        {side}
      </div>
      <div className="flex-1 bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl p-6">
        {children}
      </div>
    </section>
  );
}

// ─── Input ────────────────────────────────────────────────────────────────

export function Input({
  label,
  value,
  onChange,
  type = "text",
  readOnly,
  hint,
  placeholder,
  min,
  step,
  right,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  type?: string;
  readOnly?: boolean;
  hint?: string;
  placeholder?: string;
  min?: number;
  step?: number;
  right?: ReactNode;
}) {
  return (
    <label className="block mb-4">
      <span className="text-xs font-medium text-[var(--color-muted)] block mb-1.5 uppercase tracking-wide">
        {label}
      </span>
      <div className="relative flex items-center">
        <input
          type={type}
          readOnly={readOnly}
          value={value}
          min={min}
          step={step}
          placeholder={placeholder}
          onChange={(e) => onChange?.(e.target.value)}
          className="w-full bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[var(--color-accent)] focus:ring-1 focus:ring-[var(--color-accent)]/30 transition-all placeholder:text-[var(--color-muted)]"
        />
        {right && <div className="absolute right-3 text-[var(--color-muted)] text-xs">{right}</div>}
      </div>
      {hint && <span className="text-xs text-[var(--color-muted)] mt-1.5 block">{hint}</span>}
    </label>
  );
}

// ─── CopyField ────────────────────────────────────────────────────────────

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <label className="block mb-4">
      <span className="text-xs font-medium text-[var(--color-muted)] block mb-1.5 uppercase tracking-wide">
        {label}
      </span>
      <div className="flex gap-2">
        <input
          readOnly
          value={value}
          className="flex-1 bg-[var(--color-panel-2)] border border-[var(--color-border)] rounded-lg px-3 py-2.5 text-xs text-[var(--color-text)] font-mono truncate"
        />
        <button
          type="button"
          onClick={copy}
          className={`px-3 py-2 border rounded-lg text-xs font-medium transition-all duration-200 flex-shrink-0 ${
            copied
              ? "border-[var(--color-success)] text-[var(--color-success)] bg-[var(--color-success-dim)]"
              : "border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          }`}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </label>
  );
}

// ─── Badge ────────────────────────────────────────────────────────────────

type BadgeVariant = "success" | "danger" | "warning" | "accent" | "muted";

export function Badge({
  children,
  variant = "muted",
}: {
  children: ReactNode;
  variant?: BadgeVariant;
}) {
  const styles: Record<BadgeVariant, string> = {
    success: "bg-[var(--color-success-dim)] text-[var(--color-success)] border-[var(--color-success)]/20",
    danger:  "bg-[var(--color-danger-dim)]  text-[var(--color-danger)]  border-[var(--color-danger)]/20",
    warning: "bg-[var(--color-warning-dim)] text-[var(--color-warning)] border-[var(--color-warning)]/20",
    accent:  "bg-[var(--color-accent-dim)]  text-[var(--color-accent)]  border-[var(--color-accent)]/20",
    muted:   "bg-[#1a2438] text-[var(--color-muted)] border-[var(--color-border)]",
  };

  return (
    <span
      className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded border uppercase tracking-wider ${styles[variant]}`}
    >
      {children}
    </span>
  );
}

// ─── StatusDot ───────────────────────────────────────────────────────────

export function StatusDot({ active }: { active: boolean }) {
  return (
    <span className="relative inline-flex items-center justify-center w-4 h-4 flex-shrink-0">
      <span
        className={`w-2 h-2 rounded-full ${
          active ? "bg-[var(--color-success)]" : "bg-[var(--color-muted)]"
        }`}
      />
      {active && (
        <span className="absolute inset-0 rounded-full bg-[var(--color-success)] opacity-30 animate-ping" />
      )}
    </span>
  );
}

// ─── LongBadge ───────────────────────────────────────────────────────────

export function LongBadge() {
  return <Badge variant="accent">LONG</Badge>;
}

// ─── Spinner ────────────────────────────────────────────────────────────

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      className="animate-spin flex-shrink-0"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────

export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} />;
}

// ─── Card ────────────────────────────────────────────────────────────────

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`bg-[var(--color-panel)] border border-[var(--color-border)] rounded-xl card-hover ${className}`}
    >
      {children}
    </div>
  );
}

// ─── Toast ───────────────────────────────────────────────────────────────

export type ToastType = "success" | "error" | "info";

export interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
}

let _addToast: ((msg: string, type: ToastType) => void) | null = null;

export function toast(message: string, type: ToastType = "info") {
  _addToast?.(message, type);
}

export function ToastProvider() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const add = useCallback((message: string, type: ToastType) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev.slice(-4), { id, message, type }]);
    const timer = setTimeout(() => remove(id), 4000);
    timers.current.set(id, timer);
  }, [remove]);

  useEffect(() => {
    _addToast = add;
    return () => { _addToast = null; };
  }, [add]);

  const icons: Record<ToastType, ReactNode> = {
    success: <CheckCircle size={16} className="text-[var(--color-success)] flex-shrink-0" />,
    error:   <AlertCircle size={16} className="text-[var(--color-danger)] flex-shrink-0" />,
    info:    <Info        size={16} className="text-[var(--color-accent)] flex-shrink-0" />,
  };

  const borders: Record<ToastType, string> = {
    success: "border-l-[var(--color-success)]",
    error:   "border-l-[var(--color-danger)]",
    info:    "border-l-[var(--color-accent)]",
  };

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast-enter pointer-events-auto flex items-center gap-3 bg-[var(--color-panel-2)] border border-[var(--color-border)] border-l-4 ${borders[t.type]} rounded-lg px-4 py-3 shadow-xl min-w-[280px] max-w-[380px]`}
        >
          {icons[t.type]}
          <span className="text-sm text-[var(--color-text)] flex-1">{t.message}</span>
          <button
            type="button"
            onClick={() => remove(t.id)}
            className="text-[var(--color-muted)] hover:text-white transition-colors flex-shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
