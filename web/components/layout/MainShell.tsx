"use client";

import { useState, useLayoutEffect, useEffect, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { TopBarProvider, useSearch, useNav } from "./TopBarContext";
import { ClipboardProvider } from "./ClipboardContext";
import { UploadProvider } from "./UploadContext";
import { LiveProvider } from "@/lib/client/live";
import { UploadWidget } from "./UploadWidget";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { GlobalSearchResults } from "@/components/files/GlobalSearchResults";
import { Toaster } from "@/components/ui/Toaster";
import { DialogHost } from "@/components/ui/Dialog";
import { CollisionHost } from "@/components/files/CollisionDialog";
import { FolderPickerHost } from "@/components/files/FolderPicker";
import { ShareHost } from "@/components/files/ShareDialog";
import { registerPinUpdater } from "@/components/files/actions";
import { cn } from "@/lib/utils";
import { useNativeBridge } from "@/lib/client/native";
import { filesHref } from "@/lib/client/api";

interface MainShellProps {
  children: ReactNode;
  userName: string;
  userEmail: string;
  isOwner: boolean;
}

function MainShellInner({ children, userName, userEmail, isOwner }: MainShellProps) {
  // Read the sidebar state from the <html> class set by the inline script in layout.tsx.
  // This is synchronous with the first render, so there is zero flash on navigation.
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(() =>
    typeof document !== "undefined"
      ? !document.documentElement.classList.contains("sidebar-collapsed")
      : true
  );
  const [mounted, setMounted] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { searchQuery, debouncedQuery, searchGlobal, setSearchQuery, setSearchGlobal } = useSearch();
  const { updatePinsForMove } = useNav();

  // Keep sidebar pins valid when folders are renamed, moved or deleted.
  useEffect(() => {
    registerPinUpdater(updatePinsForMove);
    return () => registerPinUpdater(null);
  }, [updatePinsForMove]);

  useLayoutEffect(() => {
    setMounted(true);
  }, []);

  // Inside a Loom app: downloads go to the app, and the app can open folders.
  const router = useRouter();
  const openFolder = useCallback((path: string) => router.push(filesHref(path)), [router]);
  useNativeBridge(openFolder);

  const toggleDesktopSidebar = () => {
    const next = !desktopSidebarOpen;
    setDesktopSidebarOpen(next);
    localStorage.setItem("loom-sidebar", String(next));
    // Keep the <html> class in sync so the inline script reads correctly on next page load
    document.documentElement.classList.toggle("sidebar-collapsed", !next);
  };

  return (
    <div className="flex h-svh overflow-hidden bg-[hsl(var(--background))]">
      {/* Desktop sidebar container */}
      <div 
        className={cn(
          "hidden md:block relative shrink-0 z-50",
          mounted && "transition-[width] duration-300 ease-in-out",
          desktopSidebarOpen ? "w-56" : "w-16"
        )}
      >
        <div className={cn(
          "absolute top-0 left-0 h-full overflow-hidden",
          mounted && "transition-[width] duration-300 ease-in-out",
          desktopSidebarOpen ? "w-56" : "w-16"
        )}>
          <Sidebar isOwner={isOwner} userName={userName} userEmail={userEmail} collapsed={!desktopSidebarOpen} />
        </div>
        
        {/* Toggle button on the border */}
        <button
          onClick={toggleDesktopSidebar}
          className={cn(
            "absolute top-7 -translate-y-1/2 -right-2.5 z-50 flex h-5 w-5 items-center justify-center rounded-full bg-[hsl(var(--primary))] text-white shadow-md hover:bg-[hsl(var(--primary)/0.9)] transition-all duration-300"
          )}
        >
          {desktopSidebarOpen ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>

      {/* Mobile sidebar overlay */}
      {mobileSidebarOpen && (
        <div className="md:hidden fixed inset-0 z-[60] flex">
          <Sidebar
            isOwner={isOwner}
            userName={userName}
            userEmail={userEmail}
            isMobile
            onClose={() => setMobileSidebarOpen(false)}
          />
          <div
            className="flex-1 bg-black/50"
            onClick={() => setMobileSidebarOpen(false)}
          />
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar
          userName={userName}
          onMenuToggle={() => setMobileSidebarOpen(true)}
        />
        <main
          className={cn(
            "flex-1 overflow-y-auto relative pb-24 md:pb-0"
          )}
          id="main-content"
        >
          {searchGlobal && debouncedQuery && searchQuery ? (
            <GlobalSearchResults
              query={debouncedQuery}
              onClose={() => { setSearchQuery(""); setSearchGlobal(false); }} 
            />
          ) : (
            children
          )}
        </main>
      </div>

      <UploadWidget />
      <Toaster />
      <DialogHost />
      <CollisionHost />
      <FolderPickerHost />
      <ShareHost />
    </div>
  );
}

export function MainShell(props: MainShellProps) {
  return (
    <LiveProvider>
      <TopBarProvider userEmail={props.userEmail}>
        <ClipboardProvider>
          <UploadProvider>
            <MainShellInner {...props} />
          </UploadProvider>
        </ClipboardProvider>
      </TopBarProvider>
    </LiveProvider>
  );
}
