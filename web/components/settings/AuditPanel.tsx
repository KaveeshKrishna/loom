"use client";

import { useEffect, useState } from "react";
import { Loader2, ScrollText, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface AuditLog {
  id: string; action: string; userId: string | null;
  details: Record<string, unknown> | null; timestamp: string;
  user?: { name: string; email: string } | null;
}

export function AuditPanel() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = () => {
    setLoading(true);
    fetch("/api/audit")
      .then(r => r.json())
      .then(d => { setLogs(d.logs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const deleteLog = async (id: string) => {
    await fetch(`/api/audit?id=${id}`, { method: "DELETE" });
    setLogs(prev => prev.filter(l => l.id !== id));
  };

  const clearAll = async () => {
    if (!confirm("Delete all audit logs? This cannot be undone.")) return;
    setClearing(true);
    await fetch("/api/audit", { method: "DELETE" });
    setLogs([]);
    setClearing(false);
  };

  const displayed = expanded ? logs : logs.slice(0, 3);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScrollText size={18} />
          <div>
            <h2 className="text-base font-semibold">Audit Log</h2>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Last {logs.length} system actions (auto-pruned to 20).</p>
          </div>
        </div>
        {logs.length > 0 && (
          <button
            onClick={clearAll}
            disabled={clearing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))] rounded-lg hover:bg-[hsl(var(--destructive)/0.2)] transition-colors disabled:opacity-60"
          >
            {clearing ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            Clear All
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>
      ) : logs.length === 0 ? (
        <p className="text-sm text-center text-[hsl(var(--muted-foreground))] py-8">No audit events yet.</p>
      ) : (
        <>
          <div className="divide-y border rounded-xl overflow-hidden">
            {displayed.map(log => (
              <div key={log.id} className="px-4 py-3 group flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-mono font-medium">{log.action}</p>
                    <span className="text-xs text-[hsl(var(--muted-foreground))] shrink-0">{formatDate(log.timestamp)}</span>
                  </div>
                  {log.user && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">by {log.user.name}</p>}
                  {log.details && (
                    <pre className="text-xs text-[hsl(var(--muted-foreground))] mt-1 bg-[hsl(var(--accent))] px-2 py-1 rounded overflow-auto max-h-24">
                      {JSON.stringify(log.details, null, 2)}
                    </pre>
                  )}
                </div>
                <button
                  onClick={() => deleteLog(log.id)}
                  className="shrink-0 p-1.5 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.1)] transition-colors opacity-0 group-hover:opacity-100"
                  title="Delete this log"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>

          {logs.length > 3 && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))] rounded-lg transition-colors"
            >
              {expanded ? (
                <><ChevronUp size={14} /> Show less</>
              ) : (
                <><ChevronDown size={14} /> View all {logs.length} logs</>
              )}
            </button>
          )}
        </>
      )}
    </div>
  );
}
