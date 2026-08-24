"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, CheckCircle2, XCircle, Clock, Trash2, Square } from "lucide-react";

interface ScanJob {
  id: string; type: string; status: string;
  requestedAt: string; startedAt: string | null; completedAt: string | null; error: string | null;
  processedFiles?: number;
  totalFiles?: number;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "COMPLETED") return <CheckCircle2 size={14} className="text-emerald-500" />;
  if (status === "FAILED") return <XCircle size={14} className="text-rose-500" />;
  if (status === "RUNNING") return <Loader2 size={14} className="animate-spin text-[hsl(var(--primary))]" />;
  return <Clock size={14} className="text-[hsl(var(--muted-foreground))]" />;
}

export function ScanPanel() {
  const [jobs, setJobs] = useState<ScanJob[]>([]);
  const [scannerStatus, setScannerStatus] = useState("idle");
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const handleDelete = async (id: string) => {
    await fetch(`/api/scan?id=${id}`, { method: "DELETE" });
    load();
  };

  const load = () => {
    fetch("/api/scan").then(r => r.json()).then(d => {
      setJobs(d.jobs ?? []); setScannerStatus(d.scannerStatus ?? "idle"); setLoading(false);
    }).catch(() => setLoading(false));
  };

  const isRunning = jobs.some(j => j.status === "RUNNING");
  useEffect(() => { load(); const i = setInterval(load, isRunning ? 3000 : 10000); return () => clearInterval(i); }, [isRunning]);

  const trigger = async () => {
    setTriggering(true);
    await fetch("/api/scan", { method: "POST" });
    setTimeout(() => { load(); setTriggering(false); }, 500);
  };

  const [videoCacheStats, setVideoCacheStats] = useState<{ usedBytes: number, limitBytes: number, cachedVideos: number } | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  const [thumbStats, setThumbStats] = useState<{ thumbCount: number, previewCount: number, physicalFiles: number } | null>(null);
  const [resettingThumbs, setResettingThumbs] = useState(false);

  const loadThumbStats = () => {
    fetch("/api/thumbnail-cache").then(r => r.json()).then(d => {
      if (!d.error) setThumbStats(d);
    }).catch(() => {});
  };

  const loadStats = () => {
    fetch("/api/video-cache").then(r => r.json()).then(d => {
      if (!d.error) setVideoCacheStats(d);
    }).catch(() => {});
  };

  useEffect(() => { loadStats(); loadThumbStats(); }, []);

  const resetThumbnailCache = async () => {
    if (!confirm(
      "This will delete ALL thumbnail and preview data (DB records + cached files) and reset the scanner so it regenerates everything from scratch on the next scan.\n\nOriginal media files will NOT be touched.\n\nContinue?"
    )) return;
    setResettingThumbs(true);
    await fetch("/api/thumbnail-cache", { method: "DELETE" });
    // Kick off a fresh rescan automatically
    await fetch("/api/scan", { method: "POST" });
    loadThumbStats();
    load();
    setResettingThumbs(false);
  };

  const clearVideoCache = async () => {
    if (!confirm("Are you sure you want to clear the generated video cache? This will NOT delete original files on the T7.")) return;
    setClearingCache(true);
    await fetch("/api/video-cache", { method: "DELETE" });
    loadStats();
    setClearingCache(false);
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">Scanner</h2>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">The scanner automatically indexes new files when the Samsung T7 is connected. You can trigger a manual reconciliation below.</p>
      </div>

      <div className="bg-[hsl(var(--card))] border rounded-xl p-4 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Scanner status</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5 capitalize">{scannerStatus}</p>
        </div>
        <div className="flex gap-2">
          
          <button id="scan-full" onClick={() => trigger()} disabled={triggering} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-60">
            {triggering ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Scan Now
          </button>
        </div>
      </div>

      {/* ── Thumbnail & Preview Cache ──────────────────────────────────── */}
      <div className="bg-[hsl(var(--card))] border rounded-xl p-4 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Thumbnail &amp; Preview Cache</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
            {thumbStats
              ? `${thumbStats.thumbCount} thumbnails · ${thumbStats.previewCount} previews · ${thumbStats.physicalFiles} cached files`
              : "Loading..."}
          </p>
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1 max-w-xs">
            Resets all thumbnail/preview data and queues a fresh rescan to regenerate everything.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            id="reset-thumbnail-cache"
            onClick={resetThumbnailCache}
            disabled={resettingThumbs}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))] rounded-lg hover:bg-[hsl(var(--destructive)/0.2)] transition-colors disabled:opacity-60"
          >
            {resettingThumbs ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Reset Cache
          </button>
        </div>
      </div>

      <div className="bg-[hsl(var(--card))] border rounded-xl p-4 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">HLS Video Cache (NVMe)</p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
            {videoCacheStats ? (
              `${(videoCacheStats.usedBytes / 1e9).toFixed(2)} GB used of ${(videoCacheStats.limitBytes / 1e9).toFixed(0)} GB (${videoCacheStats.cachedVideos} videos)`
            ) : "Loading..."}
          </p>
        </div>
        <div className="flex gap-2">
          <button id="clear-video-cache" onClick={clearVideoCache} disabled={clearingCache || !videoCacheStats} className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))] rounded-lg hover:bg-[hsl(var(--destructive)/0.2)] transition-colors disabled:opacity-60">
            {clearingCache ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Clear Cache
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-3">Recent jobs</h3>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-[hsl(var(--muted-foreground))]" /></div>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))] text-center py-8">No scan jobs yet.</p>
        ) : (
          <div className="divide-y border rounded-xl overflow-hidden">
            {(showAll ? jobs : jobs.slice(0, 3)).map(job => (
              <div key={job.id} className="flex items-center gap-3 px-4 py-3">
                <StatusIcon status={job.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <p className="text-sm font-medium">
                      {job.type === "FULL_RESCAN" ? "Rescan Library" : job.type === "INDEX_FILE" ? "Index file" : job.type}
                    </p>
                    {job.status === "RUNNING" && typeof job.processedFiles === 'number' && typeof job.totalFiles === 'number' && job.totalFiles > 0 && (
                      <span className="text-xs font-medium text-[hsl(var(--primary))]">
                        {Math.round((job.processedFiles / job.totalFiles) * 100)}%
                      </span>
                    )}
                  </div>
                  
                  {job.status === "RUNNING" && typeof job.processedFiles === 'number' && typeof job.totalFiles === 'number' && job.totalFiles > 0 ? (
                    <div className="mt-1 mb-1.5">
                      <div className="h-1.5 w-full bg-[hsl(var(--accent))] rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-[hsl(var(--primary))] transition-all duration-500" 
                          style={{ width: `${Math.min(100, Math.max(0, (job.processedFiles / job.totalFiles) * 100))}%` }} 
                        />
                      </div>
                      <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1">
                        Scanning: {job.processedFiles.toLocaleString()} / {job.totalFiles.toLocaleString()} files
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">
                      {new Date(job.requestedAt).toLocaleString()}
                      {job.status === "COMPLETED" && job.processedFiles !== undefined ? ` • Processed ${job.processedFiles.toLocaleString()} files` : ''}
                    </p>
                  )}
                  {job.error && <p className="text-xs text-[hsl(var(--destructive))] mt-0.5">{job.error}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize
                    ${job.status === "COMPLETED" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" :
                      job.status === "FAILED" ? "bg-rose-500/10 text-rose-600 dark:text-rose-400" :
                      job.status === "RUNNING" ? "bg-[hsl(var(--primary)/0.1)] text-[hsl(var(--primary))]" :
                      job.status === "CANCELLED" ? "bg-orange-500/10 text-orange-600 dark:text-orange-400" :
                      "bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]"}`}>
                    {job.status.toLowerCase()}
                  </span>
                  {(job.status === "RUNNING" || job.status === "PENDING") ? (
                    <button onClick={() => handleDelete(job.id)} className="p-1.5 text-[hsl(var(--muted-foreground))] hover:text-rose-500 hover:bg-rose-500/10 rounded-md transition-colors" title="Stop scan">
                      <Square size={14} className="fill-current" />
                    </button>
                  ) : (
                    <button onClick={() => handleDelete(job.id)} className="p-1.5 text-[hsl(var(--muted-foreground))] hover:text-rose-500 hover:bg-rose-500/10 rounded-md transition-colors" title="Delete log">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {jobs.length > 3 && (
              <button 
                onClick={() => setShowAll(!showAll)} 
                className="w-full py-3 text-sm font-medium text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent)/0.5)] transition-colors"
              >
                {showAll ? "Show less" : `View all ${jobs.length} jobs`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
