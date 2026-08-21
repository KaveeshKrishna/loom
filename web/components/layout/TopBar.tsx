"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Search, Grid3X3, List, Menu, SunMedium, Moon, Monitor, LogOut, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth-client";

interface TopBarProps {
  onMenuToggle?: () => void;
  userName: string;
}

type Theme = "light" | "dark" | "system";

function useTheme() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const saved = localStorage.getItem("loom-theme") as Theme | null;
    setTheme(saved ?? "system");
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
  const [query, setQuery] = useState("");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { theme, applyTheme } = useTheme();
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { viewMode, setViewMode, breadcrumbs } = useTopBar();

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (query.trim()) router.push(`/search?q=${encodeURIComponent(query.trim())}`);
    },
    [query, router]
  );

  const handleSignOut = async () => {
    await signOut();
    router.push("/login");
  };

  const themeOptions: { value: Theme; icon: React.ComponentType<{ size?: number }>; label: string }[] = [
    { value: "light", icon: SunMedium, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
    { value: "system", icon: Monitor, label: "System" },
  ];
  

  return (
    <header className="h-14 border-b bg-[hsl(var(--background)/0.95)] backdrop-blur-sm flex items-center gap-3 px-4 shrink-0 sticky top-0 z-40">
      {/* Mobile menu toggle */}
      <button
        className="md:hidden p-1.5 rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"
        onClick={onMenuToggle}
        id="topbar-menu-toggle"
      >
        <Menu size={18} />
      </button>

      {/* Breadcrumbs */}
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="hidden md:flex items-center gap-1 text-sm text-[hsl(var(--muted-foreground))] min-w-0">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.href} className="flex items-center gap-1 min-w-0">
              {i > 0 && <span className="opacity-40">/</span>}
              <a
                href={crumb.href}
                className={cn(
                  "hover:text-[hsl(var(--foreground))] transition-colors truncate max-w-32",
                  i === breadcrumbs.length - 1 && "text-[hsl(var(--foreground))] font-medium"
                )}
              >
                {crumb.label}
              </a>
            </span>
          ))}
        </nav>
      )}

      {/* Search */}
      <form onSubmit={handleSearch} className="flex-1 max-w-md mx-auto">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
          <input
            id="topbar-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            className="w-full pl-9 pr-4 py-1.5 text-sm bg-[hsl(var(--accent))] rounded-lg border border-transparent focus:border-[hsl(var(--primary)/0.4)] focus:bg-[hsl(var(--background))] focus:outline-none transition-all"
          />
        </div>
      </form>

      <div className="flex items-center gap-1">
        {/* View toggle */}
        <div className="hidden sm:flex border rounded-lg overflow-hidden">
          <button
            id="topbar-grid-view"
            onClick={() => setViewMode("grid")}
            className={cn(
              "p-1.5 transition-colors",
              viewMode === "grid"
                ? "bg-[hsl(var(--primary))] text-white"
                : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
            )}
          >
            <Grid3X3 size={15} />
          </button>
          <button
            id="topbar-list-view"
            onClick={() => setViewMode("list")}
            className={cn(
              "p-1.5 transition-colors",
              viewMode === "list"
                ? "bg-[hsl(var(--primary))] text-white"
                : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))]"
            )}
          >
            <List size={15} />
          </button>
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
  );
}
