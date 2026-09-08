"use client";

import { useEffect, useState, useMemo } from "react";
import { useTopBar } from "@/components/layout/TopBarContext";
import {
  Loader2,
  ShieldAlert,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  FileWarning,
  RefreshCw,
  Search,
} from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { FileIcon } from "@/components/files/FileIcon";
import Link from "next/link";

type HealthStatus = "CORRUPT" | "UNSUPPORTED";

interface HealthNode {
  id: string;
  name: string;
  relativePath: string;
  type: string;
  mimeType: string | null;
  size: string | null;
  modifiedAt: string | null;
  healthStatus: HealthStatus;
  healthError: string | null;
  sourceVersion: string | null;
}

interface HealthSummary {
  total: number;
  corrupt: number;
  unsupported: number;
}

type FilterMode = "ALL" | "CORRUPT" | "UNSUPPORTED";

export default function HealthPage() {
  const { setBreadcrumbs } = useTopBar();
  const [nodes, setNodes] = useState<HealthNode[]>([]);
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterMode>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "File Health", href: "/health" }]);
    fetchHealth();
  }, [setBreadcrumbs]);

  const fetchHealth = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/files/health");
      const data = await res.json();
      if (data.nodes) {
        setNodes(data.nodes);
        setSummary(data.summary);
      }
    } catch (err) {
      console.error("Failed to fetch health data", err);
    } finally {
      setLoading(false);
    }
  };

  const filteredNodes = useMemo(() => {
    let result = nodes;
    if (filter !== "ALL") result = result.filter((n) => n.healthStatus === filter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (n) => n.name.toLowerCase().includes(q) || n.relativePath.toLowerCase().includes(q)
      );
    }
    return result;
  }, [nodes, filter, searchQuery]);

  const statusBadge = (status: HealthStatus) => {
    if (status === "CORRUPT") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-medium">
          <XCircle size={11} />
          Corrupt
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs font-medium">
        <AlertTriangle size={11} />
        Unsupported
      </span>
    );
  };

  return (
    <div>
      {/* Header */}
      <div className="px-6 py-5 border-b">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <ShieldAlert size={20} className="text-amber-500" />
              <h1 className="text-lg font-semibold">File Health</h1>
            </div>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
              Files that Loom could not fully analyze or generate previews for.
            </p>
          </div>
          <button
            onClick={fetchHealth}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {/* Summary Cards */}
        {summary && (
          <div className="mt-4 grid grid-cols-3 gap-3">
            <button
              onClick={() => setFilter("ALL")}
              className={`rounded-xl border p-3 text-left transition-all ${
                filter === "ALL"
                  ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.06)]"
                  : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <FileWarning size={15} className="text-[hsl(var(--muted-foreground))]" />
                <span className="text-xs text-[hsl(var(--muted-foreground))]">All Issues</span>
              </div>
              <p className="text-2xl font-bold">{summary.total}</p>
            </button>

            <button
              onClick={() => setFilter("CORRUPT")}
              className={`rounded-xl border p-3 text-left transition-all ${
                filter === "CORRUPT"
                  ? "border-red-500 bg-red-500/5"
                  : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <XCircle size={15} className="text-red-500" />
                <span className="text-xs text-[hsl(var(--muted-foreground))]">Corrupt</span>
              </div>
              <p className="text-2xl font-bold text-red-600 dark:text-red-400">{summary.corrupt}</p>
            </button>

            <button
              onClick={() => setFilter("UNSUPPORTED")}
              className={`rounded-xl border p-3 text-left transition-all ${
                filter === "UNSUPPORTED"
                  ? "border-amber-500 bg-amber-500/5"
                  : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle size={15} className="text-amber-500" />
                <span className="text-xs text-[hsl(var(--muted-foreground))]">Unsupported</span>
              </div>
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                {summary.unsupported}
              </p>
            </button>
          </div>
        )}

        {/* Search bar */}
        <div className="mt-4 relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
          <input
            type="text"
            placeholder="Search files…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-[hsl(var(--accent))] border border-[hsl(var(--border))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary)/0.4)]"
          />
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 size={24} className="animate-spin text-[hsl(var(--muted-foreground))]" />
        </div>
      ) : filteredNodes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-[hsl(var(--muted-foreground))]">
          <CheckCircle2 size={48} className="mb-4 text-emerald-500 opacity-60" />
          <p className="font-medium">
            {nodes.length === 0
              ? "No health issues found. All files are healthy!"
              : "No files match the current filter."}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[hsl(var(--border))]">
          {filteredNodes.map((node) => (
            <div key={node.id}>
              <button
                className="w-full text-left flex items-center gap-4 px-6 py-4 hover:bg-[hsl(var(--accent)/0.5)] transition-colors group"
                onClick={() => setExpandedId((prev) => (prev === node.id ? null : node.id))}
              >
                <FileIcon type={node.type as "FILE" | "DIRECTORY"} mimeType={node.mimeType} className="w-9 h-9 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium truncate max-w-sm">{node.name}</p>
                    {statusBadge(node.healthStatus)}
                  </div>
                  <p className="text-xs text-[hsl(var(--muted-foreground))] truncate mt-0.5">
                    {node.relativePath}
                  </p>
                </div>
                <div className="text-right shrink-0 text-sm text-[hsl(var(--muted-foreground))]">
                  <p>{node.size ? formatBytes(Number(node.size)) : "—"}</p>
                  {node.modifiedAt && (
                    <p className="text-xs">
                      {new Date(node.modifiedAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
              </button>

              {/* Expanded error detail */}
              {expandedId === node.id && node.healthError && (
                <div className="px-6 pb-4">
                  <div className="ml-13 pl-4 border-l-2 border-red-500/30">
                    <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">
                      Error details:
                    </p>
                    <pre className="text-xs font-mono text-red-600 dark:text-red-400 bg-red-500/5 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all">
                      {node.healthError}
                    </pre>
                    <div className="mt-2 flex items-center gap-3">
                      <Link
                        href={`/files/${node.relativePath.split("/").slice(0, -1).join("/") || ""}`}
                        className="text-xs text-[hsl(var(--primary))] hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Go to folder →
                      </Link>
                    </div>
                  </div>
                </div>
              )}
              {expandedId === node.id && !node.healthError && (
                <div className="px-6 pb-4">
                  <div className="ml-13 pl-4 border-l-2 border-amber-500/30">
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">
                      {node.healthStatus === "UNSUPPORTED"
                        ? "This file format is not supported by Loom's preview pipeline. The file itself is likely valid."
                        : "No additional error details recorded."}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
