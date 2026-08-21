"use client";

import { useEffect, useState } from "react";
import { Loader2, ScrollText } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface AuditLog {
  id: string; action: string; userId: string | null;
  details: Record<string, unknown> | null; timestamp: string;
  user?: { name: string; email: string } | null;
}

export function AuditPanel() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/audit").then(r => r.json()).then(d => { setLogs(d.logs ?? []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <ScrollText size={18} />
        <div>
          <h2 className="text-base font-semibold">Audit Log</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Recent system actions.</p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>
      ) : logs.length === 0 ? (
        <p className="text-sm text-center text-[hsl(var(--muted-foreground))] py-8">No audit events yet.</p>
      ) : (
        <div className="divide-y border rounded-xl overflow-hidden">
          {logs.map(log => (
            <div key={log.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs font-mono font-medium">{log.action}</p>
                <span className="text-xs text-[hsl(var(--muted-foreground))] shrink-0">{formatDate(log.timestamp)}</span>
              </div>
              {log.user && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">by {log.user.name}</p>}
              {log.details && (
                <pre className="text-xs text-[hsl(var(--muted-foreground))] mt-1 bg-[hsl(var(--accent))] px-2 py-1 rounded overflow-auto">
                  {JSON.stringify(log.details, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
