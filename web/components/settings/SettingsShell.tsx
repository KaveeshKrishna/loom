"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Users, ShieldCheck, ScanLine, ScrollText, HardDrive } from "lucide-react";
import { StoragePanel } from "./StoragePanel";
import { UsersPanel } from "./UsersPanel";
import { AclPanel } from "./AclPanel";
import { ScanPanel } from "./ScanPanel";
import { AuditPanel } from "./AuditPanel";
import { cn } from "@/lib/utils";
import { useNav } from "@/components/layout/TopBarContext";

const tabs = [
  { id: "users", label: "Users", icon: Users },
  { id: "acl", label: "Permissions", icon: ShieldCheck },
  { id: "scan", label: "Scanner", icon: ScanLine },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "audit", label: "Audit Log", icon: ScrollText },
];

export function SettingsShell() {
  // useSearchParams needs a Suspense boundary for static rendering (demo build).
  return (
    <Suspense fallback={null}>
      <SettingsInner />
    </Suspense>
  );
}

function SettingsInner() {
  // The active tab lives in the URL (?tab=...) so it survives reloads and can be linked to.
  const params = useSearchParams();
  const router = useRouter();
  const fromUrl = params.get("tab");
  const [activeTab, setActiveTabState] = useState(tabs.some((t) => t.id === fromUrl) ? fromUrl! : "users");
  const setActiveTab = (id: string) => {
    setActiveTabState(id);
    router.replace(`/settings?tab=${id}`, { scroll: false });
  };
  useEffect(() => {
    if (fromUrl && tabs.some((t) => t.id === fromUrl)) setActiveTabState(fromUrl);
  }, [fromUrl]);
  const { setBreadcrumbs } = useNav();

  useEffect(() => {
    setBreadcrumbs([{ label: "Settings", href: "/settings" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="flex flex-col md:flex-row h-full">
      {/* Settings sidebar */}
      <div className="w-full md:w-48 border-b md:border-b-0 md:border-r shrink-0 py-2 md:py-4 px-2 overflow-x-auto no-scrollbar">
        <h2 className="hidden md:block text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider px-3 mb-2">
          Settings
        </h2>
        <nav className="flex md:flex-col space-x-1 md:space-x-0 md:space-y-0.5">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`settings-tab-${id}`}
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex items-center gap-2.5 md:w-full text-left px-3 py-2 rounded-md text-sm transition-colors whitespace-nowrap shrink-0",
                activeTab === id
                  ? "bg-[hsl(var(--sidebar-item-active))] text-[hsl(var(--sidebar-item-active-text))] font-medium"
                  : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === "users" && <UsersPanel />}
        {activeTab === "acl" && <AclPanel />}
        {activeTab === "scan" && <ScanPanel />}
        {activeTab === "storage" && <StoragePanel />}
        {activeTab === "audit" && <AuditPanel />}
      </div>
    </div>
  );
}
