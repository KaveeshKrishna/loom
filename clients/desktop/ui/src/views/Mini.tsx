/**
 * The floating mini Transfers bar (what minimizing Transfers turns into):
 * overall progress, speed and what's left, with pause/resume, back to the
 * full window, and close. Drag it anywhere; it stays on top.
 */

import { useEffect, useState } from "react";
import { Pause, Play, Maximize2, X, Wifi, CheckCircle2, CloudOff, AlertTriangle } from "lucide-react";
import { api, listen, type Snapshot } from "../lib/ipc";
import { speed, timeLeft } from "../lib/format";
import { IconButton } from "../components/ui";

/** A small progress ring. */
function Ring({ value, tone }: { value: number; tone: "primary" | "muted" | "success" }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const color = tone === "success" ? "hsl(var(--success))" : tone === "muted" ? "hsl(var(--muted-foreground))" : "hsl(var(--primary))";
  return (
    <svg width="38" height="38" viewBox="0 0 38 38" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx="19" cy="19" r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="3.5" />
      <circle
        cx="19"
        cy="19"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))}
        style={{ transition: "stroke-dashoffset 500ms ease-out" }}
      />
    </svg>
  );
}

export function Mini() {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    api.snapshot().then(setSnap);
    const off = listen<Snapshot>("snapshot", setSnap);
    return () => void off.then((f) => f());
  }, []);

  const left = snap ? snap.active + snap.queued + snap.waiting : 0;
  const done = snap != null && left === 0 && snap.paused === 0 && snap.failed + snap.conflicts === 0;

  // Nothing left to do: say so, then get out of the way.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => api.closeMini(), 6000);
    return () => clearTimeout(t);
  }, [done]);

  if (!snap) return null;
  const fraction = snap.bytesTotal ? snap.bytesDone / snap.bytesTotal : done ? 1 : 0;
  const pct = Math.floor(fraction * 100);
  const paused = snap.allPaused || (left === 0 && snap.paused > 0);

  let title: string;
  let detail: string;
  if (done) {
    title = "All transfers finished";
    detail = "Nothing left to do";
  } else if (snap.offline) {
    title = "Waiting for Loom";
    detail = `${left.toLocaleString()} left · continues when it’s back`;
  } else if (paused) {
    title = `Paused · ${pct}%`;
    detail = `${(left + snap.paused).toLocaleString()} left`;
  } else {
    title = snap.bytesPerSecond > 0 ? `${pct}% · ${speed(snap.bytesPerSecond)}` : `${pct}%`;
    const eta = snap.bytesPerSecond > 0 ? timeLeft(snap.bytesTotal - snap.bytesDone, snap.bytesPerSecond) : "";
    detail = [`${left.toLocaleString()} left`, eta].filter(Boolean).join(" · ");
  }
  const attention = snap.failed + snap.conflicts;

  return (
    <div
      data-tauri-drag-region
      className="flex h-full items-center gap-3 border border-[hsl(var(--border))] bg-[hsl(var(--surface))] pl-3 pr-2 select-none"
      role="status"
      aria-label="Transfers"
    >
      <div className="relative" data-tauri-drag-region>
        <Ring value={fraction} tone={done ? "success" : paused || snap.offline ? "muted" : "primary"} />
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[hsl(var(--muted-foreground))]">
          {done ? (
            <CheckCircle2 size={15} className="text-[hsl(var(--success))]" />
          ) : snap.offline ? (
            <CloudOff size={14} />
          ) : paused ? (
            <Pause size={13} />
          ) : null}
        </div>
      </div>
      <div className="min-w-0 flex-1" data-tauri-drag-region>
        <div className="flex items-center gap-2 text-sm font-semibold tabular-nums" data-tauri-drag-region>
          <span className="truncate" data-tauri-drag-region>
            {title}
          </span>
          {snap.via === "lan" && !done && !paused && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-[hsl(var(--success))]" title="Straight to the server over your home network">
              <Wifi size={11} /> Direct
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs tabular-nums text-[hsl(var(--muted-foreground))]" data-tauri-drag-region>
          <span className="truncate" data-tauri-drag-region>
            {detail}
          </span>
          {attention > 0 && (
            <span
              className="inline-flex shrink-0 items-center gap-1 font-medium text-[hsl(var(--warning))]"
              title={`${attention.toLocaleString()} need${attention === 1 ? "s" : ""} attention: open Transfers`}
            >
              <AlertTriangle size={11} /> {attention.toLocaleString()}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center">
        {!done && (
          <IconButton label={paused ? "Resume all" : "Pause all"} onClick={() => (paused ? api.resume(null) : api.pause(null))}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </IconButton>
        )}
        <IconButton label="Open Transfers" onClick={() => api.openTransfers()}>
          <Maximize2 size={14} />
        </IconButton>
        <IconButton label="Close" onClick={() => api.closeMini()}>
          <X size={15} />
        </IconButton>
      </div>
    </div>
  );
}
