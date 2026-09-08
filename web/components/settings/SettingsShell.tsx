"use client";

import { useState, useEffect } from "react";
import { Users, ShieldCheck, ScanLine, ScrollText } from "lucide-react";
import { UsersPanel } from "./UsersPanel";
import { AclPanel } from "./AclPanel";
import { ScanPanel } from "./ScanPanel";
import { AuditPanel } from "./AuditPanel";
import { cn } from "@/lib/utils";
import { useTopBar } from "@/components/layout/TopBarContext";

const tabs = [
  { id: "users", label: "Users", icon: Users },
  { id: "acl", label: "Permissions", icon: ShieldCheck },
  { id: "scan", label: "Scanner", icon: ScanLine },
  { id: "audit", label: "Audit Log", icon: ScrollText },
];

export function SettingsShell() {
  const [activeTab, setActiveTab] = useState("users");
  const { setBreadcrumbs } = useTopBar();

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
        {activeTab === "audit" && <AuditPanel />}
      </div>
    </div>
  );
}
