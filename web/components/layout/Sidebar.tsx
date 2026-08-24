"use client";
import React from "react";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useCallback } from "react";
import {
  Star, FolderOpen, Image, Video, FileText,
  Settings, ChevronRight, X, MoreVertical
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ArchiveStatusBadge } from "@/components/ui/ArchiveStatusBadge";
import { useTopBar } from "./TopBarContext";

import { useContextMenu } from "@/hooks/useContextMenu";
import { ContextMenu } from "../files/ContextMenu";
import type { FileNode } from "@prisma/client";

const navItems = [
  { href: "/files", label: "All Files", icon: FolderOpen },
  { href: "/favorites", label: "Favorites", icon: Star },
  { href: "/photos", label: "Photos", icon: Image },
  { href: "/videos", label: "Videos", icon: Video },
  { href: "/documents", label: "Documents", icon: FileText },
];

interface SidebarProps {
  isOwner: boolean;
  userName: string;
  userEmail: string;
  onClose?: () => void;
  isMobile?: boolean;
  collapsed?: boolean;
}

export function Sidebar({ isOwner, userName, userEmail, onClose, isMobile, collapsed }: SidebarProps) {
  const pathname = usePathname();
  const { pins } = useTopBar();
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const contextMenu = useContextMenu();

  const handleLongPressClear = useCallback(() => {
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    longPressFiredRef.current = false;
  }, []);

  const handleLongPressEnd = useCallback((e: React.TouchEvent) => {
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    if (longPressFiredRef.current && e.cancelable) e.preventDefault();
  }, []);

  return (
    <aside
      className={cn(
        "flex flex-col h-full border-r bg-[hsl(var(--sidebar))]",
        collapsed ? "w-16" : "w-56",
        isMobile && "fixed inset-y-0 left-0 z-[60] shadow-2xl w-56"
      )}
    >
      {/* Header */}
      <div className={cn("flex items-center h-14 border-b border-[hsl(var(--sidebar-border))]", collapsed ? "justify-center px-0" : "justify-between px-5")}>
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[hsl(var(--primary))] flex items-center justify-center shrink-0">
            <span className="text-white text-sm font-bold">L</span>
          </div>
          {!collapsed && (
            <span className="text-sm font-semibold tracking-tight text-[hsl(var(--foreground))]">
              Loom
            </span>
          )}
        </div>
        {isMobile && (
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-[hsl(var(--accent))]">
            <X size={16} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = href === "/files"
            ? pathname === "/files" || pathname.startsWith("/files/")
            : pathname === href;
          return (
            <Link
              key={href}
              href={href}
              onClick={onClose}
              title={collapsed ? label : undefined}
              className={cn(
                "flex items-center rounded-md text-sm transition-all duration-150 active:scale-[0.98]",
                collapsed ? "justify-center py-3 px-0" : "gap-2.5 px-3 py-2",
                active
                  ? "bg-[hsl(var(--sidebar-item-active))] text-[hsl(var(--sidebar-item-active-text))] font-medium"
                  : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--sidebar-item-hover))] hover:text-[hsl(var(--foreground))]"
              )}
            >
              <Icon size={collapsed ? 18 : 16} />
              {!collapsed && (
                <>
                  {label}
                  {active && <ChevronRight size={14} className="ml-auto opacity-60" />}
                </>
              )}
            </Link>
          );
        })}

        {pins.length > 0 && (
          <>
            <div className="my-2 mx-3 border-t border-[hsl(var(--sidebar-border))]" />
            {pins.map((pin) => {
              const active = pathname === pin.href || pathname.startsWith(`${pin.href}/`);
              const mockNode = { id: pin.id, type: "DIRECTORY", name: pin.name, relativePath: pin.href.replace("/files/", "") } as FileNode;
              
              return (
                <div
                  key={pin.id}
                  className="relative group flex items-center"
                  onContextMenu={(e: React.MouseEvent) => {
                    e.preventDefault();
                    contextMenu.open(e, mockNode);
                  }}
                  onTouchStart={(e: React.TouchEvent) => {
                    longPressFiredRef.current = false;
                    touchTimerRef.current = setTimeout(() => {
                      longPressFiredRef.current = true;
                      contextMenu.open(e, mockNode);
                    }, 500);
                  }}
                  onTouchMove={handleLongPressClear}
                  onTouchEnd={handleLongPressEnd}
                >
                  <Link
                    href={pin.href}
                    onClick={(e) => {
                      if (longPressFiredRef.current) {
                        e.preventDefault();
                        return;
                      }
                      if (onClose) onClose();
                    }}
                    title={collapsed ? pin.name : undefined}
                    className={cn(
                      "flex items-center rounded-md text-sm transition-all duration-150 flex-1 min-w-0 active:scale-[0.98]",
                      collapsed ? "justify-center py-3 px-0" : "gap-2.5 px-3 py-2",
                      active
                        ? "bg-[hsl(var(--sidebar-item-active))] text-[hsl(var(--sidebar-item-active-text))] font-medium"
                        : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--sidebar-item-hover))] hover:text-[hsl(var(--foreground))]"
                    )}
                  >
                    <FolderOpen size={collapsed ? 18 : 16} className="shrink-0" />
                    {!collapsed && (
                      <span className="truncate pr-4">{pin.name}</span>
                    )}
                  </Link>
                  {!collapsed && (
                    <div className="relative shrink-0 pr-2 lg:opacity-0 lg:group-hover:opacity-100 opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          contextMenu.open(e, mockNode, { current: e.currentTarget as HTMLElement });
                        }}
                        className="p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] transition-all"
                      >
                        <MoreVertical size={16} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {isOwner && (
          <>
            <div className="my-2 mx-3 border-t border-[hsl(var(--sidebar-border))]" />
            <Link
              href="/settings"
              onClick={onClose}
              title={collapsed ? "Settings" : undefined}
              className={cn(
                "flex items-center rounded-md text-sm transition-all duration-150 active:scale-[0.98]",
                collapsed ? "justify-center py-3 px-0" : "gap-2.5 px-3 py-2",
                pathname === "/settings" || pathname.startsWith("/settings/")
                  ? "bg-[hsl(var(--sidebar-item-active))] text-[hsl(var(--sidebar-item-active-text))] font-medium"
                  : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--sidebar-item-hover))] hover:text-[hsl(var(--foreground))]"
              )}
            >
              <Settings size={collapsed ? 18 : 16} />
              {!collapsed && "Settings"}
            </Link>
          </>
        )}
      </nav>

      {/* Footer */}
      <div className={cn("px-3 py-3 border-t border-[hsl(var(--sidebar-border))] space-y-2", collapsed && "flex flex-col items-center px-0")}>
        {!collapsed && <ArchiveStatusBadge />}
        <div className={cn("flex items-center", collapsed ? "justify-center" : "gap-2.5 px-1 py-1")}>
          <div className="w-7 h-7 rounded-full bg-[hsl(var(--primary)/0.15)] flex items-center justify-center shrink-0">
            <span className="text-xs font-semibold text-[hsl(var(--primary))]">
              {userName.charAt(0).toUpperCase()}
            </span>
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{userName}</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">{userEmail}</p>
            </div>
          )}
        </div>
      </div>
      
      {contextMenu.isOpen && contextMenu.node && contextMenu.position && (
        <ContextMenu 
          node={contextMenu.node} 
          position={contextMenu.position} 
          onClose={contextMenu.close} 
        />
      )}
    </aside>
  );
}

