"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Star, FolderOpen, Image, Video, FileText, Settings, ChevronRight, X, Trash2, ShieldAlert, Clock, Music, PinOff, MoreVertical, Folder, Link2, MonitorSmartphone, ArrowDownUp, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNav } from "./TopBarContext";
import { Menu } from "@/components/files/Menu";
import { LOOM_DRAG_TYPE } from "@/lib/client/drop";
import { moveItems, copyItems, trashItems } from "@/components/files/actions";
import { StorageMeter } from "./StorageMeter";
import { hasNative, nativeApp, openNativeWindow, useNativeTransfers } from "@/lib/client/native";
import { LoomLogo } from "@/components/ui/LoomLogo";

const navItems = [
  { href: "/files", label: "All Files", icon: FolderOpen },
  { href: "/recent", label: "Recent", icon: Clock },
  { href: "/favorites", label: "Starred", icon: Star },
  { href: "/photos", label: "Photos", icon: Image },
  { href: "/videos", label: "Videos", icon: Video },
  { href: "/audio", label: "Audio", icon: Music },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/shared", label: "Shared links", icon: Link2 },
  { href: "/trash", label: "Trash", icon: Trash2 },
];

interface SidebarProps {
  isOwner: boolean;
  userName: string;
  userEmail: string;
  onClose?: () => void;
  isMobile?: boolean;
  collapsed?: boolean;
}

/** Accept files dragged from the grid; call onPaths with their relative paths. */
function useDropTarget(onPaths: (paths: string[], copy: boolean) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(LOOM_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.altKey || e.ctrlKey ? "copy" : "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const raw = e.dataTransfer.getData(LOOM_DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        onPaths(JSON.parse(raw), e.altKey || e.ctrlKey);
      },
    },
  };
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
  onClick,
  dropTo,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  active: boolean;
  collapsed?: boolean;
  onClick?: () => void;
  dropTo?: (paths: string[], copy: boolean) => void;
}) {
  const drop = useDropTarget(dropTo ?? (() => {}));
  return (
    <Link
      href={href}
      onClick={onClick}
      title={collapsed ? label : undefined}
      {...(dropTo ? drop.props : {})}
      className={cn(
        "flex items-center rounded-md text-sm transition-all duration-150 active:scale-[0.98]",
        collapsed ? "justify-center py-3 px-0" : "gap-2.5 px-3 py-2",
        active
          ? "bg-[hsl(var(--sidebar-item-active))] text-[hsl(var(--sidebar-item-active-text))] font-medium"
          : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--sidebar-item-hover))] hover:text-[hsl(var(--foreground))]",
        drop.over && "ring-2 ring-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.1)]"
      )}
    >
      <Icon size={collapsed ? 18 : 16} className="shrink-0" />
      {!collapsed && (
        <>
          <span className="truncate">{label}</span>
          {active && <ChevronRight size={14} className="ml-auto opacity-60" />}
        </>
      )}
    </Link>
  );
}

/** A sidebar entry that opens one of the app's own windows. */
function AppButton({
  label,
  icon: Icon,
  collapsed,
  onClick,
  badge,
  tone,
}: {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  collapsed?: boolean;
  onClick: () => void;
  badge?: number;
  tone?: "warning";
}) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={cn(
        "relative flex w-full items-center rounded-md text-sm transition-all duration-150 active:scale-[0.98] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--sidebar-item-hover))] hover:text-[hsl(var(--foreground))]",
        collapsed ? "justify-center py-3 px-0" : "gap-2.5 px-3 py-2"
      )}
    >
      <Icon size={collapsed ? 18 : 16} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      {!!badge && (
        <span
          className={cn(
            "min-w-[1.25rem] h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums flex items-center justify-center",
            tone === "warning" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]",
            collapsed ? "absolute top-1 right-1.5 h-4 min-w-[1rem] px-1 text-[10px]" : "ml-auto"
          )}
        >
          {badge > 999 ? "999+" : badge}
        </span>
      )}
    </button>
  );
}

/** "This PC" / "This device": the Loom app's Transfers and settings, when Loom runs inside the app. */
function AppSection({ collapsed, onClose }: { collapsed?: boolean; onClose?: () => void }) {
  // After mount: the server render never has the app.
  const [app, setApp] = useState<{ title: string; settings: boolean } | null>(null);
  useEffect(() => {
    if (hasNative("transfers")) setApp({ title: nativeApp()?.platform === "windows" ? "This PC" : "This device", settings: hasNative("settings") });
  }, []);
  const t = useNativeTransfers();
  if (!app) return null;
  const busy = t ? t.active + t.queued : 0;
  const attention = t?.failed ?? 0;
  const open = (which: "transfers" | "settings") => {
    onClose?.();
    openNativeWindow(which);
  };
  return (
    <>
      <div className="my-2 mx-3 border-t border-[hsl(var(--sidebar-border))]" />
      {!collapsed && <p className="px-3 pb-1 text-[11px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{app.title}</p>}
      <AppButton
        label="Transfers"
        icon={ArrowDownUp}
        collapsed={collapsed}
        onClick={() => open("transfers")}
        badge={attention || busy}
        tone={attention ? "warning" : undefined}
      />
      {app.settings && <AppButton label="App settings" icon={SlidersHorizontal} collapsed={collapsed} onClick={() => open("settings")} />}
    </>
  );
}

export function Sidebar({ isOwner, userName, userEmail, onClose, isMobile, collapsed }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { pins, togglePin } = useNav();
  const [pinMenu, setPinMenu] = useState<{ x: number; y: number; pin: (typeof pins)[number] } | null>(null);

  return (
    <aside
      className={cn(
        "flex flex-col h-full border-r bg-[hsl(var(--sidebar))]",
        collapsed ? "w-16" : "w-56",
        isMobile && "fixed inset-y-0 left-0 z-[60] shadow-2xl w-64"
      )}
    >
      <div className={cn("flex items-center h-14 border-b border-[hsl(var(--sidebar-border))]", collapsed ? "justify-center px-0" : "justify-between px-5")}>
        <Link href="/files" className="flex items-center gap-2.5" onClick={onClose}>
          <LoomLogo size={28} className="shrink-0" />
          {!collapsed && <span className="text-sm font-semibold tracking-tight text-[hsl(var(--foreground))]">Loom</span>}
        </Link>
        {isMobile && (
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))]" aria-label="Close menu">
            <X size={16} />
          </button>
        )}
      </div>

      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto" aria-label="Main">
        {navItems.map(({ href, label, icon }) => (
          <NavLink
            key={href}
            href={href}
            label={label}
            icon={icon}
            collapsed={collapsed}
            onClick={onClose}
            active={href === "/files" ? pathname === "/files" || pathname.startsWith("/files/") : pathname === href}
            dropTo={
              href === "/files"
                ? (paths, copy) => (copy ? copyItems(paths, "") : moveItems(paths, ""))
                : href === "/trash"
                  ? (paths) => trashItems(paths.map((p) => ({ id: "", relativePath: p, name: p.split("/").pop()! })), { confirm: true })
                  : undefined
            }
          />
        ))}

        {pins.length > 0 && (
          <>
            <div className="my-2 mx-3 border-t border-[hsl(var(--sidebar-border))]" />
            {!collapsed && <p className="px-3 pb-1 text-[11px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">Pinned</p>}
            {pins.map((pin) => {
              const pinPath = pin.path ?? decodeURIComponent(pin.href.replace(/^\/files\/?/, ""));
              const active = pathname === pin.href || pathname.startsWith(`${pin.href}/`);
              return (
                <div
                  key={pin.id}
                  className="relative group flex items-center"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPinMenu({ x: e.clientX, y: e.clientY, pin });
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <NavLink
                      href={pin.href}
                      label={pin.name}
                      icon={Folder}
                      collapsed={collapsed}
                      onClick={onClose}
                      active={active}
                      dropTo={(paths, copy) => (copy ? copyItems(paths, pinPath) : moveItems(paths, pinPath))}
                    />
                  </div>
                  {!collapsed && (
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        const r = e.currentTarget.getBoundingClientRect();
                        setPinMenu({ x: r.right, y: r.bottom, pin });
                      }}
                      className="absolute right-1 p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] lg:can-hover:opacity-0 lg:group-hover:opacity-100 focus:opacity-100"
                      aria-label={`${pin.name} options`}
                    >
                      <MoreVertical size={15} />
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}

        <AppSection collapsed={collapsed} onClose={onClose} />

        <div className="my-2 mx-3 border-t border-[hsl(var(--sidebar-border))]" />
        <NavLink href="/devices" label="Devices" icon={MonitorSmartphone} collapsed={collapsed} onClick={onClose} active={pathname === "/devices"} />
        {isOwner && (
          <NavLink href="/health" label="File Health" icon={ShieldAlert} collapsed={collapsed} onClick={onClose} active={pathname === "/health"} />
        )}
        {isOwner && (
          <NavLink
            href="/settings"
            label="Settings"
            icon={Settings}
            collapsed={collapsed}
            onClick={onClose}
            active={pathname === "/settings" || pathname.startsWith("/settings/")}
          />
        )}
      </nav>

      {!collapsed && <StorageMeter isOwner={isOwner} />}

      <div className={cn("px-3 py-3 border-t border-[hsl(var(--sidebar-border))]", collapsed && "flex flex-col items-center px-0")}>
        <div className={cn("flex items-center", collapsed ? "justify-center" : "gap-2.5 px-1 py-1")}>
          <div className="w-7 h-7 rounded-full bg-[hsl(var(--primary)/0.15)] flex items-center justify-center shrink-0">
            <span className="text-xs font-semibold text-[hsl(var(--primary))]">{userName.charAt(0).toUpperCase()}</span>
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{userName}</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">{userEmail}</p>
            </div>
          )}
        </div>
      </div>

      {pinMenu && (
        <Menu
          x={pinMenu.x}
          y={pinMenu.y}
          onClose={() => setPinMenu(null)}
          header={pinMenu.pin.name}
          items={[
            { label: "Open", icon: <FolderOpen size={15} />, onClick: () => router.push(pinMenu.pin.href) },
            { label: "Unpin", icon: <PinOff size={15} />, onClick: () => togglePin(pinMenu.pin) },
          ]}
        />
      )}
    </aside>
  );
}
