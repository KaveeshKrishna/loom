"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Clock, Star, FolderOpen, Image, Video, FileText,
  Settings, ChevronRight, X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ArchiveStatusBadge } from "@/components/ui/ArchiveStatusBadge";

const navItems = [
  { href: "/files", label: "All Files", icon: FolderOpen },
  { href: "/recent", label: "Recent", icon: Clock },
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
}

export function Sidebar({ isOwner, userName, userEmail, onClose, isMobile }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        "flex flex-col h-full w-64 border-r bg-[hsl(var(--sidebar))]",
        isMobile && "fixed inset-y-0 left-0 z-50 shadow-2xl"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 h-16 border-b border-[hsl(var(--sidebar-border))]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[hsl(var(--primary))] flex items-center justify-center">
            <span className="text-white text-sm font-bold">L</span>
          </div>
          <span className="text-sm font-semibold tracking-tight text-[hsl(var(--foreground))]">
            Loom
          </span>
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
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors duration-150",
                active
                  ? "bg-[hsl(var(--sidebar-item-active))] text-[hsl(var(--sidebar-item-active-text))] font-medium"
                  : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--sidebar-item-hover))] hover:text-[hsl(var(--foreground))]"
              )}
            >
              <Icon size={16} />
              {label}
              {active && <ChevronRight size={14} className="ml-auto opacity-60" />}
            </Link>
          );
        })}

        {isOwner && (
          <>
            <div className="my-2 mx-3 border-t border-[hsl(var(--sidebar-border))]" />
            <Link
              href="/settings"
              onClick={onClose}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors duration-150",
                pathname === "/settings" || pathname.startsWith("/settings/")
                  ? "bg-[hsl(var(--sidebar-item-active))] text-[hsl(var(--sidebar-item-active-text))] font-medium"
                  : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--sidebar-item-hover))] hover:text-[hsl(var(--foreground))]"
              )}
            >
              <Settings size={16} />
              Settings
            </Link>
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-[hsl(var(--sidebar-border))] space-y-2">
        <ArchiveStatusBadge />
        <div className="flex items-center gap-2.5 px-1 py-1">
          <div className="w-7 h-7 rounded-full bg-[hsl(var(--primary)/0.15)] flex items-center justify-center shrink-0">
            <span className="text-xs font-semibold text-[hsl(var(--primary))]">
              {userName.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium truncate">{userName}</p>
            <p className="text-xs text-[hsl(var(--muted-foreground))] truncate">{userEmail}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
