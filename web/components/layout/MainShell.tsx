"use client";

import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { MobileNav } from "./MobileNav";
import { TopBarProvider } from "./TopBarContext";
import { cn } from "@/lib/utils";

interface MainShellProps {
  children: React.ReactNode;
  userName: string;
  userEmail: string;
  isOwner: boolean;
}

export function MainShell({ children, userName, userEmail, isOwner }: MainShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <TopBarProvider>
      <div className="flex h-svh overflow-hidden bg-[hsl(var(--background))]">
        {/* Desktop sidebar */}
        <div className="hidden md:flex shrink-0">
          <Sidebar isOwner={isOwner} userName={userName} userEmail={userEmail} />
        </div>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div className="md:hidden fixed inset-0 z-50 flex">
            <Sidebar
              isOwner={isOwner}
              userName={userName}
              userEmail={userEmail}
              isMobile
              onClose={() => setSidebarOpen(false)}
            />
            <div
              className="flex-1 bg-black/50"
              onClick={() => setSidebarOpen(false)}
            />
          </div>
        )}

        {/* Main content */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <TopBar
            userName={userName}
            onMenuToggle={() => setSidebarOpen(true)}
          />
          <main
            className={cn(
              "flex-1 overflow-y-auto",
              // pb for mobile nav
              "pb-20 md:pb-0"
            )}
            id="main-content"
          >
            {children}
          </main>
        </div>

        {/* Mobile bottom nav */}
        <MobileNav isOwner={isOwner} />
      </div>
    </TopBarProvider>
  );
}
