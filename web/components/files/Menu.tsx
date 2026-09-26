"use client";

/**
 * Positioned popup menu (context menus, "New", "Sort"...). Keeps itself on
 * screen, closes on outside click / Escape / scroll, and supports arrow-key
 * navigation.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  shortcut?: string;
  separatorBefore?: boolean;
}

export function Menu({
  x,
  y,
  items,
  onClose,
  header,
  width = 224,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  header?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y, visible: false });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const M = 8;
    let nx = x + r.width + M > vw ? x - r.width : x;
    let ny = y + r.height + M > vh ? y - r.height : y;
    nx = Math.max(M, Math.min(nx, vw - r.width - M));
    ny = Math.max(M, Math.min(ny, vh - r.height - M));
    setPos({ x: nx, y: ny, visible: true });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const els = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? []);
        if (!els.length) return;
        const i = els.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "ArrowDown" ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
        els[next].focus();
      }
    };
    const t = setTimeout(() => document.addEventListener("pointerdown", onDown), 0);
    document.addEventListener("keydown", onKey, true);
    const main = document.getElementById("main-content");
    main?.addEventListener("scroll", onClose, { passive: true });
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
      main?.removeEventListener("scroll", onClose);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y, visibility: pos.visible ? "visible" : "hidden", width }}
      className="fixed z-[120] bg-[hsl(var(--card))] border rounded-xl shadow-xl py-1.5 animate-in-slide-up max-h-[80vh] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {header && <div className="px-3 pb-1.5 mb-1 border-b text-xs text-[hsl(var(--muted-foreground))] truncate">{header}</div>}
      {items.map((item, i) => {
        const cls = cn(
          "flex items-center gap-3 w-full text-left px-3 py-2 text-sm transition-colors outline-none focus:bg-[hsl(var(--accent))]",
          item.danger ? "text-red-500 hover:bg-red-500/10" : "text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]",
          item.disabled && "opacity-40 pointer-events-none"
        );
        const inner = (
          <>
            <span className="w-4 shrink-0 flex justify-center">{item.icon}</span>
            <span className="flex-1 truncate">{item.label}</span>
            {item.checked && <span className="text-[hsl(var(--primary))]">✓</span>}
            {item.shortcut && <span className="text-[11px] text-[hsl(var(--muted-foreground))]">{item.shortcut}</span>}
          </>
        );
        return (
          <div key={i}>
            {item.separatorBefore && <div className="my-1 border-t" />}
            {item.href ? (
              <a role="menuitem" href={item.href} className={cls} onClick={onClose} aria-disabled={item.disabled}>
                {inner}
              </a>
            ) : (
              <button
                role="menuitem"
                className={cls}
                aria-disabled={item.disabled}
                onClick={() => {
                  onClose();
                  item.onClick?.();
                }}
              >
                {inner}
              </button>
            )}
          </div>
        );
      })}
    </div>,
    document.body
  );
}
