/** Small building blocks: buttons, switches, selects, progress, dialogs. */

import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none",
        size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-8 px-3 text-sm",
        variant === "primary" && "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:bg-[hsl(var(--primary-hover))]",
        variant === "secondary" && "bg-[hsl(var(--surface))] border border-[hsl(var(--border-strong))] hover:bg-[hsl(var(--accent))]",
        variant === "ghost" && "hover:bg-[hsl(var(--accent))]",
        variant === "danger" && "bg-[hsl(var(--danger))] text-white hover:opacity-90",
        className
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex items-center justify-center w-7 h-7 rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] transition-colors disabled:opacity-40",
        className
      )}
    >
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-5 w-10 shrink-0 items-center rounded-full border transition-colors",
        checked ? "bg-[hsl(var(--primary))] border-[hsl(var(--primary))]" : "bg-transparent border-[hsl(var(--muted-foreground))]"
      )}
    >
      <span
        className={cx(
          "inline-block rounded-full transition-all",
          checked ? "h-3 w-3 translate-x-[22px] bg-[hsl(var(--primary-foreground))]" : "h-3 w-3 translate-x-[3px] bg-[hsl(var(--muted-foreground))]"
        )}
      />
    </button>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
      className="h-8 rounded-md border border-[hsl(var(--border-strong))] bg-[hsl(var(--surface))] px-2 pr-7 text-sm"
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Progress({ value, tone = "primary", className }: { value: number; tone?: "primary" | "muted" | "success" | "warning" | "danger"; className?: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cx("h-1 overflow-hidden rounded-full bg-[hsl(var(--border))]", className ?? "w-full")}
    >
      <div
        className={cx(
          "h-full rounded-full transition-[width] duration-500 ease-out",
          tone === "primary" && "bg-[hsl(var(--primary))]",
          tone === "muted" && "bg-[hsl(var(--muted-foreground))]",
          tone === "success" && "bg-[hsl(var(--success))]",
          tone === "warning" && "bg-[hsl(var(--warning))]",
          tone === "danger" && "bg-[hsl(var(--danger))]"
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Dialog({ title, children, footer, onClose, wide }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLElement>("button, [href], input, select")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx("flex max-h-full w-full flex-col rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))] shadow-2xl", wide ? "max-w-2xl" : "max-w-md")}
      >
        <h2 className="px-5 pt-4 pb-2 font-[family-name:var(--font-display)] text-base font-semibold">{title}</h2>
        <div className="min-h-0 overflow-y-auto px-5 pb-4">{children}</div>
        <div className="flex justify-end gap-2 rounded-b-lg border-t border-[hsl(var(--border))] bg-[hsl(var(--background))] px-5 py-3">{footer}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      {title && <h2 className="px-1 text-[13px] font-semibold text-[hsl(var(--muted-foreground))]">{title}</h2>}
      <div className="divide-y divide-[hsl(var(--border))] rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))]">{children}</div>
    </section>
  );
}

/** Loom's mark, as in the web app. */
export function LoomMark({ size = 40 }: { size?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-[22%] bg-[hsl(var(--primary))] text-white font-bold shadow-sm"
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      aria-hidden
    >
      L
    </div>
  );
}
