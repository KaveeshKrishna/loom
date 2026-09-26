"use client";

/**
 * Accessible modal dialog + promise-based confirm()/prompt() replacements.
 *
 *   const ok = await dialogs.confirm({ title: "Delete 3 items?", danger: true });
 *   const name = await dialogs.prompt({ title: "New folder", defaultValue: "Untitled" });
 *
 * <DialogHost/> (mounted once in MainShell) renders queued dialogs.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    // Focus the first input, else the dialog itself.
    setTimeout(() => {
      const input = ref.current?.querySelector<HTMLElement>("input, textarea, select");
      (input ?? ref.current)?.focus();
    }, 0);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          "bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-xl shadow-2xl w-full overflow-hidden animate-in-pop outline-none flex flex-col max-h-[90vh]",
          wide ? "max-w-2xl" : "max-w-md"
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b">
            <h2 id={labelledBy} className="text-base font-semibold truncate text-[hsl(var(--foreground))]">
              {title}
            </h2>
            <button onClick={onClose} className="p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]" aria-label="Close">
              <X size={16} />
            </button>
          </div>
        )}
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-3 border-t flex justify-end gap-2 bg-[hsl(var(--muted)/0.4)]">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export function Button({
  children,
  variant = "secondary",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  return (
    <button
      {...rest}
      className={cn(
        "px-3.5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-ring",
        variant === "primary" && "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] hover:bg-[hsl(var(--primary)/0.9)]",
        variant === "secondary" && "border bg-[hsl(var(--card))] hover:bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        variant === "ghost" && "hover:bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]",
        className
      )}
    >
      {children}
    </button>
  );
}

// ─── promise-based confirm / prompt ─────────────────────────────────────────

type Pending =
  | { kind: "confirm"; title: string; message?: string; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void }
  | {
      kind: "prompt";
      title: string;
      message?: string;
      defaultValue?: string;
      placeholder?: string;
      confirmLabel?: string;
      selectBaseName?: boolean;
      validate?: (v: string) => string | null;
      resolve: (v: string | null) => void;
    };

let queue: Pending[] = [];
const listeners = new Set<(q: Pending[]) => void>();
const emit = () => listeners.forEach((l) => l([...queue]));

export const dialogs = {
  confirm(opts: { title: string; message?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
    return new Promise((resolve) => {
      queue.push({ kind: "confirm", ...opts, resolve });
      emit();
    });
  },
  prompt(opts: {
    title: string;
    message?: string;
    defaultValue?: string;
    placeholder?: string;
    confirmLabel?: string;
    selectBaseName?: boolean;
    validate?: (v: string) => string | null;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      queue.push({ kind: "prompt", ...opts, resolve });
      emit();
    });
  },
};

export function DialogHost() {
  const [q, setQ] = useState<Pending[]>([]);
  useEffect(() => {
    listeners.add(setQ);
    return () => {
      listeners.delete(setQ);
    };
  }, []);
  const current = q[0];
  const close = (value: boolean | string | null) => {
    if (!current) return;
    queue = queue.slice(1);
    emit();
    (current.resolve as (v: boolean | string | null) => void)(value);
  };
  if (!current) return null;
  if (current.kind === "confirm") {
    return (
      <Dialog
        open
        onClose={() => close(false)}
        title={current.title}
        footer={
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={current.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
              {current.confirmLabel ?? "OK"}
            </Button>
          </>
        }
      >
        {current.message && <p className="text-sm text-[hsl(var(--muted-foreground))] whitespace-pre-line">{current.message}</p>}
      </Dialog>
    );
  }
  return <PromptBody key={queue.length + current.title} p={current} close={close} />;
}

function PromptBody({ p, close }: { p: Extract<Pending, { kind: "prompt" }>; close: (v: string | null) => void }) {
  const [value, setValue] = useState(p.defaultValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    setTimeout(() => {
      el.focus();
      const v = el.value;
      const dot = v.lastIndexOf(".");
      if (p.selectBaseName && dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    }, 10);
  }, [p.selectBaseName]);
  const submit = () => {
    const err = p.validate?.(value) ?? null;
    if (err) return setError(err);
    close(value);
  };
  return (
    <Dialog
      open
      onClose={() => close(null)}
      title={p.title}
      footer={
        <>
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()}>
            {p.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      {p.message && <p className="text-sm text-[hsl(var(--muted-foreground))] mb-3">{p.message}</p>}
      <input
        ref={inputRef}
        value={value}
        placeholder={p.placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        className="w-full px-3 py-2 rounded-lg border bg-[hsl(var(--background))] text-sm focus:outline-none focus:border-[hsl(var(--primary))]"
      />
      {error && <p className="text-xs text-red-500 mt-1.5">{error}</p>}
    </Dialog>
  );
}

/** Client-side mirror of the server's name rules, for instant feedback. */
export function validateFileName(name: string): string | null {
  if (!name.trim()) return "Name can't be empty";
  if (name === "." || name === "..") return "That name isn't allowed";
  if (name.includes("/")) return "Names can't contain /";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return "Name contains invalid characters";
  if (new TextEncoder().encode(name).length > 255) return "Name is too long";
  if (name === ".LoomTrash" || name === ".tmp-upload") return "That name is reserved";
  return null;
}
