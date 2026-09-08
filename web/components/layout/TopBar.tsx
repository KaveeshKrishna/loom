"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { Search, Grid3X3, List, Menu, SunMedium, Moon, Monitor, LogOut, ChevronDown, Globe, FolderSearch, X, Bell, CheckCircle2, AlertCircle } from "lucide-react";
import { cn, truncateName } from "@/lib/utils";
import { signOut } from "@/lib/auth-client";
import type { Notification } from "@prisma/client";


interface TopBarProps {
  onMenuToggle?: () => void;
  userName: string;
}

type Theme = "light" | "dark" | "system";

function useTheme() {
  const [theme, setTheme] = useState<Theme>("system");

  // useLayoutEffect fires before paint — applies saved theme immediately,
  // preventing the white/light flash on initial load or navigation.
  useLayoutEffect(() => {
    const saved = localStorage.getItem("loom-theme") as Theme | null;
    const t = saved ?? "system";
    setTheme(t);
    const isDark =
      t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  const applyTheme = useCallback((t: Theme) => {
    setTheme(t);
    localStorage.setItem("loom-theme", t);
    const isDark =
      t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  return { theme, applyTheme };
}

import { useTopBar } from "./TopBarContext";

export function TopBar({ onMenuToggle, userName }: TopBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const isSettingsPage = pathname === "/settings" || pathname.startsWith("/settings/");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { theme, applyTheme } = useTheme();
  const { viewMode, setViewMode, gridSize, setGridSize, breadcrumbs, searchQuery, setSearchQuery, searchGlobal, setSearchGlobal } = useTopBar();
  const [gridMenuOpen, setGridMenuOpen] = useState(false);
  const gridMenuRef = useRef<HTMLDivElement>(null);
  
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) {
        const data = await res.json();
        setNotifications(data);
      }
    } catch (e) {
      console.error("Failed to fetch notifications", e);
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000); // poll every 30s
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  const dismissNotification = async (id?: string) => {
    try {
      await fetch("/api/notifications/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { notificationId: id } : { dismissAll: true })
      });
      if (id) {
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
      } else {
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      }
    } catch (e) {
      console.error("Failed to dismiss notifications", e);
    }
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
      if (gridMenuRef.current && !gridMenuRef.current.contains(e.target as Node)) {
        setGridMenuOpen(false);
      }
      if (notificationsRef.current && !notificationsRef.current.contains(e.target as Node)) {
        setNotificationsOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);


  const handleSignOut = async () => {
    await signOut();
    router.push("/login");
  };

  const themeOptions: { value: Theme; icon: React.ComponentType<{ size?: number }>; label: string }[] = [
    { value: "light", icon: SunMedium, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
    { value: "system", icon: Monitor, label: "System" },
  ];

  // No manual slicing here, we will let CSS handle the scrolling
  const visibleBreadcrumbs = breadcrumbs;

  const searchInputContent = (
    <>
      {breadcrumbs && (breadcrumbs.length > 1 || (breadcrumbs.length === 1 && breadcrumbs[0].href !== "/files")) && (
        <button
          onClick={() => setSearchGlobal(!searchGlobal)}
          className="p-1.5 rounded-lg text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] transition-colors shrink-0"
          title={searchGlobal ? "Search everywhere" : "Search in current folder"}
        >
          {searchGlobal ? <Globe size={16} /> : <FolderSearch size={16} />}
        </button>
      )}
      <div className="relative w-full min-w-[50px]">
        {searchQuery ? (
          <button
            onClick={() => { setSearchQuery(""); setSearchGlobal(false); }}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--background))] p-0.5 rounded-full transition-colors z-10"
            title="Clear search"
          >
            <X size={15} />
          </button>
        ) : (
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
        )}
        <input
          id="topbar-search"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={
            searchGlobal || (breadcrumbs.length === 1 && breadcrumbs[0].href === "/files")
              ? "Search all files..."
              : breadcrumbs.length > 0
              ? `Search ${truncateName(breadcrumbs[breadcrumbs.length - 1].label, 15)} folder`
              : "Search files..."
          }
          className="w-full pl-9 pr-4 py-2 md:py-1.5 text-base md:text-sm bg-[hsl(var(--accent))] rounded-xl md:rounded-lg border border-transparent focus:border-[hsl(var(--primary)/0.4)] focus:bg-[hsl(var(--background))] focus:outline-none transition-all text-ellipsis overflow-hidden whitespace-nowrap"
        />
      </div>
    </>
  );

  return (
    <>
      <header className="h-14 border-b bg-[hsl(var(--background)/0.95)] backdrop-blur-sm flex items-center gap-3 px-4 md:pl-8 shrink-0 sticky top-0 z-40">
        {/* Mobile Menu toggle */}
        <button
          className="md:hidden p-1.5 rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
          onClick={onMenuToggle}
          id="topbar-menu-toggle"
        >
          <Menu size={18} />
        </button>

        {/* Breadcrumbs */}
        {visibleBreadcrumbs && visibleBreadcrumbs.length > 0 && (
          <nav className="flex items-center gap-1 text-sm text-[hsl(var(--muted-foreground))] flex-1 min-w-0 overflow-x-auto no-scrollbar mask-gradient-right mr-2 md:mr-4">
            {visibleBreadcrumbs.map((crumb, i) => {
              return (
                <span key={`${crumb.href}-${i}`} className="flex items-center gap-1 shrink-0">
                  {i > 0 && <span className="opacity-40">/</span>}
                  <Link
                    href={crumb.href}
                    className={cn(
                      "hover:text-[hsl(var(--foreground))] transition-colors",
                      i === visibleBreadcrumbs.length - 1 && "text-[hsl(var(--foreground))] font-medium"
                    )}
                    title={crumb.label}
                  >
                    {truncateName(crumb.label, 15)}
                  </Link>
                </span>
              );
            })}
          </nav>
        )}

        {/* Spacer to push search to the right if no breadcrumbs */}
        {!(visibleBreadcrumbs && visibleBreadcrumbs.length > 0) && (
          <div className="flex-1 min-w-[8px]" />
        )}

        {/* Desktop Search — hidden on settings page */}
        {!isSettingsPage && (
          <div className="hidden md:flex items-center gap-2 max-w-[280px] w-full shrink">
            {searchInputContent}
          </div>
        )}

      <div className="flex items-center gap-1 shrink-0 ml-auto">
        {/* View toggle */}
        <div className="hidden md:flex rounded-lg shrink-0 border border-[hsl(var(--border))]">
          <div className="relative flex" ref={gridMenuRef}>
            <button
              id="topbar-grid-view"
              onClick={() => setViewMode("grid")}
              className={cn(
                "p-1.5 transition-colors rounded-l-[7px] border-r border-transparent",
                viewMode === "grid"
                  ? "bg-[hsl(var(--primary))] text-white border-[hsl(var(--background)/0.2)]"
                  : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] border-[hsl(var(--border))]"
              )}
            >
              <Grid3X3 size={15} />
            </button>
            <button
              onClick={() => setGridMenuOpen(v => !v)}
              className={cn(
                "p-1.5 transition-colors flex items-center justify-center",
                viewMode === "grid"
                  ? "bg-[hsl(var(--primary))] text-white hover:bg-[hsl(var(--primary)/0.9)]"
                  : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
              )}
            >
              <ChevronDown size={12} />
            </button>

            {gridMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-32 bg-[hsl(var(--card))] border rounded-xl shadow-lg py-1 animate-in-slide-up z-50">
                <button
                  onClick={() => { setGridSize("sm"); setGridMenuOpen(false); setViewMode("grid"); }}
                  className={cn("w-full text-left px-3 py-1.5 text-sm hover:bg-[hsl(var(--accent))]", gridSize === "sm" && "text-[hsl(var(--primary))] font-medium")}
                >
                  Small
                </button>
                <button
                  onClick={() => { setGridSize("md"); setGridMenuOpen(false); setViewMode("grid"); }}
                  className={cn("w-full text-left px-3 py-1.5 text-sm hover:bg-[hsl(var(--accent))]", gridSize === "md" && "text-[hsl(var(--primary))] font-medium")}
                >
                  Medium
                </button>
                <button
                  onClick={() => { setGridSize("lg"); setGridMenuOpen(false); setViewMode("grid"); }}
                  className={cn("w-full text-left px-3 py-1.5 text-sm hover:bg-[hsl(var(--accent))]", gridSize === "lg" && "text-[hsl(var(--primary))] font-medium")}
                >
                  Large
                </button>
                <button
                  onClick={() => { setGridSize("xl"); setGridMenuOpen(false); setViewMode("grid"); }}
                  className={cn("w-full text-left px-3 py-1.5 text-sm hover:bg-[hsl(var(--accent))]", gridSize === "xl" && "text-[hsl(var(--primary))] font-medium")}
                >
                  Extra Large
                </button>
              </div>
            )}
          </div>
          <button
            id="topbar-list-view"
            onClick={() => setViewMode("list")}
            className={cn(
              "p-1.5 transition-colors rounded-r-[7px]",
              viewMode === "list"
                ? "bg-[hsl(var(--primary))] text-white"
                : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
            )}
          >
            <List size={15} />
          </button>
        </div>

        {/* Notifications */}
        <div className="relative" ref={notificationsRef}>
          <button
            onClick={() => setNotificationsOpen((v) => !v)}
            className={cn(
              "p-1.5 transition-colors rounded-lg relative",
              notificationsOpen ? "bg-[hsl(var(--accent))] text-[hsl(var(--foreground))]" : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
            )}
            title="Notifications"
          >
            <Bell size={18} />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[hsl(var(--destructive))] border border-[hsl(var(--background))]" />
            )}
          </button>

          {notificationsOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-80 bg-[hsl(var(--card))] border rounded-xl shadow-lg py-2 animate-in-slide-up z-50 overflow-hidden flex flex-col max-h-[400px]">
              <div className="px-4 py-2 border-b flex items-center justify-between shrink-0">
                <p className="font-medium text-sm">Notifications</p>
                {unreadCount > 0 && (
                  <button 
                    onClick={() => dismissNotification()}
                    className="text-xs text-[hsl(var(--primary))] hover:underline"
                  >
                    Mark all as read
                  </button>
                )}
              </div>
              <div className="overflow-y-auto overflow-x-hidden p-2 flex-1 no-scrollbar flex flex-col gap-1">
                {notifications.length === 0 ? (
                  <p className="text-sm text-[hsl(var(--muted-foreground))] text-center py-6">No notifications</p>
                ) : (
                  notifications.map(notification => (
                    <div 
                      key={notification.id} 
                      className={cn(
                        "flex gap-3 p-3 rounded-lg text-sm transition-colors relative group",
                        !notification.read ? "bg-[hsl(var(--primary)/0.05)]" : "hover:bg-[hsl(var(--accent))]"
                      )}
                    >
                      <div className="shrink-0 mt-0.5">
                        {notification.type.includes("FAILED") || notification.type.includes("INTERRUPTED") ? (
                          <AlertCircle size={16} className="text-[hsl(var(--destructive))]" />
                        ) : (
                          <CheckCircle2 size={16} className="text-[hsl(var(--primary))]" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={cn("font-medium truncate", !notification.read && "text-[hsl(var(--foreground))]")}>
                          {notification.title}
                        </p>
                        <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5 break-words">
                          {notification.message}
                        </p>
                        <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-1 opacity-70">
                          {new Date(notification.createdAt).toLocaleString()}
                        </p>
                      </div>
                      {!notification.read && (
                        <button
                          onClick={(e) => { e.stopPropagation(); dismissNotification(notification.id); }}
                          className="absolute right-2 top-2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-[hsl(var(--background))] transition-opacity"
                          title="Mark as read"
                        >
                          <X size={14} className="text-[hsl(var(--muted-foreground))]" />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* User menu */}
        <div className="relative" ref={userMenuRef}>
          <button
            id="topbar-user-menu"
            onClick={() => setUserMenuOpen((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm hover:bg-[hsl(var(--accent))] transition-colors"
          >
            <div className="w-6 h-6 rounded-full bg-[hsl(var(--primary)/0.15)] flex items-center justify-center">
              <span className="text-xs font-semibold text-[hsl(var(--primary))]">
                {userName.charAt(0).toUpperCase()}
              </span>
            </div>
            <ChevronDown size={13} className="text-[hsl(var(--muted-foreground))]" />
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-48 bg-[hsl(var(--card))] border rounded-xl shadow-lg py-1 animate-in-slide-up z-50">
              <div className="px-3 py-2 border-b">
                <p className="text-xs font-medium">{userName}</p>
              </div>

              {/* View toggle (mobile only) */}
              <div className="md:hidden px-2 py-1.5 border-b">
                <p className="text-xs text-[hsl(var(--muted-foreground))] px-1 mb-1">View</p>
                <div className="flex gap-1 mb-2">
                  <button
                    onClick={() => { setViewMode("grid"); }}
                    className={cn(
                      "flex-1 flex items-center justify-center py-1.5 rounded-md text-xs transition-colors",
                      viewMode === "grid"
                        ? "bg-[hsl(var(--primary))] text-white"
                        : "hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
                    )}
                  >
                    <Grid3X3 size={13} />
                  </button>
                  <button
                    onClick={() => { setViewMode("list"); setUserMenuOpen(false); }}
                    className={cn(
                      "flex-1 flex items-center justify-center py-1.5 rounded-md text-xs transition-colors",
                      viewMode === "list"
                        ? "bg-[hsl(var(--primary))] text-white"
                        : "hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
                    )}
                  >
                    <List size={13} />
                  </button>
                </div>
                {viewMode === "grid" && (
                  <>
                    <p className="text-xs text-[hsl(var(--muted-foreground))] px-1 mb-1 mt-2">Grid Size</p>
                    <div className="flex gap-1">
                      {(["sm", "md", "lg", "xl"] as const).map((size) => (
                        <button
                          key={size}
                          onClick={() => { setGridSize(size); setUserMenuOpen(false); }}
                          className={cn(
                            "flex-1 flex items-center justify-center py-1.5 rounded-md text-[10px] font-medium transition-colors uppercase",
                            gridSize === size
                              ? "bg-[hsl(var(--primary))] text-white"
                              : "hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
                          )}
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Theme */}
              <div className="px-2 py-1.5">
                <p className="text-xs text-[hsl(var(--muted-foreground))] px-1 mb-1">Theme</p>
                <div className="flex gap-1">
                  {themeOptions.map(({ value, icon: Icon, label }) => (
                    <button
                      key={value}
                      id={`theme-${value}`}
                      onClick={() => applyTheme(value)}
                      title={label}
                      className={cn(
                        "flex-1 flex items-center justify-center py-1.5 rounded-md text-xs transition-colors",
                        theme === value
                          ? "bg-[hsl(var(--primary))] text-white"
                          : "hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
                      )}
                    >
                      <Icon size={13} />
                    </button>
                  ))}
                </div>
              </div>

              <div className="border-t mt-1 pt-1 px-2">
                <button
                  id="topbar-signout"
                  onClick={handleSignOut}
                  className="flex items-center gap-2 w-full text-left px-2 py-2 text-sm text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] rounded-md transition-colors"
                >
                  <LogOut size={14} />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      </header>

      {/* Mobile Floating Search — hidden on settings page */}
      {!isSettingsPage && (
        <div className="md:hidden fixed bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-3rem)] max-w-[320px] flex items-center gap-2 z-50 shadow-2xl bg-[hsl(var(--background)/0.95)] backdrop-blur-md p-1.5 rounded-2xl border border-[hsl(var(--border))]">
          {searchInputContent}
        </div>
      )}
    </>
  );
}
