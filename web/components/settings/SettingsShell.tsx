"use client";

import { useState } from "react";
import { Users, ShieldCheck, ScanLine, HardDrive, ScrollText } from "lucide-react";
import { UsersPanel } from "./UsersPanel";
import { AclPanel } from "./AclPanel";
import { ScanPanel } from "./ScanPanel";
import { ArchivePanel } from "./ArchivePanel";
import { AuditPanel } from "./AuditPanel";
import { cn } from "@/lib/utils";

const tabs = [
  { id: "users", label: "Users", icon: Users },
  { id: "acl", label: "Permissions", icon: ShieldCheck },
  { id: "scan", label: "Scanner", icon: ScanLine },
  { id: "archive", label: "Archive", icon: HardDrive },
  { id: "audit", label: "Audit Log", icon: ScrollText },
];

export function SettingsShell() {
  const [activeTab, setActiveTab] = useState("users");

  return (
    <div className="flex h-full">
      {/* Settings sidebar */}
      <div className="w-52 border-r shrink-0 py-4 px-2">
        <h2 className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider px-3 mb-2">
          Settings
        </h2>
        <nav className="space-y-0.5">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`settings-tab-${id}`}
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
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
        {activeTab === "archive" && <ArchivePanel />}
        {activeTab === "audit" && <AuditPanel />}
      </div>
    </div>
  );
}
