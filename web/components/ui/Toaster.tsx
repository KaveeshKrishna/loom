"use client";

/**
 * Minimal toast notifications with an optional action (e.g. Undo).
 *
 *   toast.success("Moved 3 items", { action: { label: "Undo", onClick } })
 *   toast.error("Couldn't rename: name already exists")
 *
 * Works from anywhere (not only React components); <Toaster/> renders them.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, AlertCircle, Info, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Kind = "success" | "error" | "info" | "loading";
interface ToastItem {
  id: number;
  kind: Kind;
  message: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}

let nextId = 1;
let items: ToastItem[] = [];
const subs = new Set<(t: ToastItem[]) => void>();
const emit = () => subs.forEach((s) => s([...items]));

function push(kind: Kind, message: string, opts: { action?: ToastItem["action"]; duration?: number } = {}): number {
  const id = nextId++;
  const duration = opts.duration ?? (kind === "error" ? 7000 : opts.action ? 6000 : kind === "loading" ? 0 : 3500);
  items = [...items.slice(-4), { id, kind, message, action: opts.action, duration }];
  emit();
  if (duration > 0) setTimeout(() => dismiss(id), duration);
  return id;
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

function update(id: number, kind: Kind, message: string, opts: { action?: ToastItem["action"]; duration?: number } = {}) {
  if (!items.some((t) => t.id === id)) return push(kind, message, opts);
  const duration = opts.duration ?? (kind === "error" ? 7000 : opts.action ? 6000 : 3500);
  items = items.map((t) => (t.id === id ? { ...t, kind, message, action: opts.action, duration } : t));
  emit();
  if (duration > 0) setTimeout(() => dismiss(id), duration);
  return id;
}

export const toast = {
  success: (m: string, o?: { action?: ToastItem["action"]; duration?: number }) => push("success", m, o),
  error: (m: string, o?: { action?: ToastItem["action"]; duration?: number }) => push("error", m, o),
  info: (m: string, o?: { action?: ToastItem["action"]; duration?: number }) => push("info", m, o),
  loading: (m: string) => push("loading", m),
  update,
  dismiss,
};

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    subs.add(setList);
    return () => {
      subs.delete(setList);
    };
  }, []);
  if (!mounted) return null;
  return createPortal(
    <div className="fixed z-[200] bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 flex flex-col gap-2 w-[calc(100%-2rem)] max-w-md pointer-events-none" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-xl bg-[hsl(var(--card))] text-sm animate-in-slide-up",
            t.kind === "error" && "border-red-500/40"
          )}
        >
          <span className="mt-0.5 shrink-0">
            {t.kind === "success" && <CheckCircle2 size={16} className="text-emerald-500" />}
            {t.kind === "error" && <AlertCircle size={16} className="text-red-500" />}
            {t.kind === "info" && <Info size={16} className="text-[hsl(var(--primary))]" />}
            {t.kind === "loading" && <Loader2 size={16} className="animate-spin text-[hsl(var(--primary))]" />}
          </span>
          <span className="flex-1 min-w-0 break-words text-[hsl(var(--foreground))]">{t.message}</span>
          {t.action && (
            <button
              className="shrink-0 font-semibold text-[hsl(var(--primary))] hover:underline"
              onClick={() => {
                dismiss(t.id);
                t.action!.onClick();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button onClick={() => dismiss(t.id)} className="shrink-0 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}
