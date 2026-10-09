/**
 * The Transfers window: everything being uploaded or downloaded, IDM-style.
 * Filters on the left, totals and controls on top, one row per transfer
 * (a folder or a set of files) that expands to its files.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine, ArrowUpFromLine, ArrowUpDown, Pause, Play, X, RotateCcw, ChevronRight, CheckCircle2, AlertTriangle,
  Settings as SettingsIcon, FolderOpen, ExternalLink, Wifi, CloudOff, LogIn, HardDrive, Upload, FolderUp, MoreHorizontal, Trash2, FileWarning,
} from "lucide-react";
import { api, listen, type Batch, type Item, type Snapshot } from "../lib/ipc";
import { bytes, speed, timeLeft, count, ago, fileName, folderLabel } from "../lib/format";
import { Button, IconButton, Progress, cx } from "../components/ui";
import { ConflictDialog } from "./ConflictDialog";
import { SettingsView } from "./Settings";

type Filter = "all" | "uploads" | "downloads" | "paused" | "attention" | "done";

const EMPTY: Snapshot = {
  active: 0, queued: 0, paused: 0, waiting: 0, failed: 0, conflicts: 0, bytesDone: 0, bytesTotal: 0, bytesPerSecond: 0,
  via: null, offline: false, signedOut: false, diskFull: false, allPaused: false,
};

const isDone = (b: Batch) => b.state === "done" || b.state === "cancelled";
const needsAttention = (b: Batch) => b.filesFailed > 0 || b.filesConflict > 0;

export function TransfersWindow() {
  const [view, setView] = useState<"transfers" | "settings">(location.hash.includes("settings") ? "settings" : "transfers");
  const [filter, setFilter] = useState<Filter>("all");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [reviewing, setReviewing] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setBatches(await api.batches(true));
  }, []);

  useEffect(() => {
    refresh();
    api.snapshot().then(setSnap);
    // Name conflicts found for a new upload: ask right away.
    const review = () =>
      api.takeReview().then((id) => {
        if (id == null) return;
        setView("transfers");
        setReviewing(id);
      });
    review();
    const t = setInterval(refresh, 1000);
    const offs = [
      listen<Snapshot>("snapshot", setSnap),
      listen("engine-event", () => refresh()),
      listen<string>("navigate", (to) => setView(to === "settings" ? "settings" : "transfers")),
      listen("review", () => review()),
    ];
    return () => {
      clearInterval(t);
      offs.forEach((p) => p.then((off) => off()));
    };
  }, [refresh]);

  const counts = useMemo(
    () => ({
      all: batches.filter((b) => !isDone(b)).length,
      uploads: batches.filter((b) => !isDone(b) && b.direction === "upload").length,
      downloads: batches.filter((b) => !isDone(b) && b.direction === "download").length,
      paused: batches.filter((b) => !isDone(b) && b.paused).length,
      attention: batches.filter(needsAttention).length,
      done: batches.filter(isDone).length,
    }),
    [batches]
  );

  const shown = batches.filter((b) => {
    switch (filter) {
      case "all":
        return !isDone(b) || needsAttention(b);
      case "uploads":
        return !isDone(b) && b.direction === "upload";
      case "downloads":
        return !isDone(b) && b.direction === "download";
      case "paused":
        return !isDone(b) && b.paused;
      case "attention":
        return needsAttention(b);
      case "done":
        return isDone(b);
    }
  });

  return (
    <div className="flex h-full">
      <nav aria-label="Transfers" className="flex w-52 shrink-0 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--rail))] p-2">
        <RailItem icon={<ArrowUpDown size={16} />} label="All transfers" count={counts.all} active={view === "transfers" && filter === "all"} onClick={() => { setView("transfers"); setFilter("all"); }} />
        <RailItem icon={<ArrowUpFromLine size={16} />} label="Uploads" count={counts.uploads} active={view === "transfers" && filter === "uploads"} onClick={() => { setView("transfers"); setFilter("uploads"); }} />
        <RailItem icon={<ArrowDownToLine size={16} />} label="Downloads" count={counts.downloads} active={view === "transfers" && filter === "downloads"} onClick={() => { setView("transfers"); setFilter("downloads"); }} />
        <RailItem icon={<Pause size={16} />} label="Paused" count={counts.paused} active={view === "transfers" && filter === "paused"} onClick={() => { setView("transfers"); setFilter("paused"); }} />
        <RailItem icon={<AlertTriangle size={16} />} label="Needs attention" count={counts.attention} tone={counts.attention ? "warning" : undefined} active={view === "transfers" && filter === "attention"} onClick={() => { setView("transfers"); setFilter("attention"); }} />
        <RailItem icon={<CheckCircle2 size={16} />} label="Completed" count={counts.done} active={view === "transfers" && filter === "done"} onClick={() => { setView("transfers"); setFilter("done"); }} />
        <div className="flex-1" />
        <RailItem icon={<SettingsIcon size={16} />} label="Settings" active={view === "settings"} onClick={() => setView("settings")} />
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        {view === "settings" ? (
          <SettingsView />
        ) : (
          <>
            <Header snap={snap} filter={filter} onClearFinished={async () => { await api.clearFinished(); refresh(); }} />
            <Banners snap={snap} />
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {shown.length === 0 ? (
                <Empty filter={filter} />
              ) : (
                <ul className="space-y-2 pt-1" aria-label="Transfers list">
                  {shown.map((b) => (
                    <BatchRow key={b.id} b={b} onChanged={refresh} onReview={() => setReviewing(b.id)} />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </main>

      {reviewing != null && <ConflictDialog batchId={reviewing} onClose={() => { setReviewing(null); refresh(); }} />}
    </div>
  );
}

function RailItem({ icon, label, count, active, onClick, tone }: { icon: React.ReactNode; label: string; count?: number; active: boolean; onClick: () => void; tone?: "warning" }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors",
        active ? "bg-[hsl(var(--accent))] font-medium" : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))]"
      )}
    >
      {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-[hsl(var(--primary))]" />}
      <span className={cx(active && "text-[hsl(var(--primary))]")}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {count != null && count > 0 && (
        <span className={cx("tabular text-xs", tone === "warning" ? "font-semibold text-[hsl(var(--warning))]" : "text-[hsl(var(--muted-foreground))]")}>{count}</span>
      )}
    </button>
  );
}

function Header({ snap, filter, onClearFinished }: { snap: Snapshot; filter: Filter; onClearFinished: () => void }) {
  const busy = snap.active + snap.queued + snap.waiting > 0;
  const remaining = snap.bytesTotal - snap.bytesDone;
  const [menu, setMenu] = useState(false);
  return (
    <header className="px-4 pt-4 pb-3">
      <div className="flex items-center gap-2">
        <h1 className="font-[family-name:var(--font-display)] text-xl font-semibold">Transfers</h1>
        {snap.via === "lan" && busy && (
          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-[hsl(var(--success)/0.12)] px-2 py-0.5 text-xs font-medium text-[hsl(var(--success))]" title="Going straight to your server over your home network">
            <Wifi size={12} /> Direct
          </span>
        )}
        <div className="flex-1" />
        {filter === "done" ? (
          <Button size="sm" onClick={onClearFinished}>
            <Trash2 size={14} /> Clear list
          </Button>
        ) : snap.allPaused ? (
          <Button size="sm" onClick={() => api.resume(null)}>
            <Play size={14} /> Resume all
          </Button>
        ) : (
          <Button size="sm" onClick={() => api.pause(null)} disabled={!busy && snap.paused === 0}>
            <Pause size={14} /> Pause all
          </Button>
        )}
        <div className="relative">
          <Button size="sm" variant="primary" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>
            <Upload size={14} /> Upload
          </Button>
          {menu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-1 shadow-xl">
                <MenuItem icon={<Upload size={15} />} label="Files…" onClick={() => { setMenu(false); api.pickUpload("files"); }} />
                <MenuItem icon={<FolderUp size={15} />} label="A folder…" onClick={() => { setMenu(false); api.pickUpload("folder"); }} />
              </div>
            </>
          )}
        </div>
      </div>
      {busy && snap.bytesTotal > 0 && (
        <div className="mt-3">
          <Progress value={snap.bytesDone / snap.bytesTotal} className="w-full" />
          <p className="tabular mt-1.5 flex gap-3 text-xs text-[hsl(var(--muted-foreground))]">
            <span>
              {bytes(snap.bytesDone)} of {bytes(snap.bytesTotal)}
            </span>
            {snap.bytesPerSecond > 0 && <span>{speed(snap.bytesPerSecond)}</span>}
            {snap.bytesPerSecond > 0 && <span>{timeLeft(remaining, snap.bytesPerSecond)}</span>}
            <span className="flex-1" />
            <span>{count(snap.active, "file")} moving, {snap.queued.toLocaleString()} waiting</span>
          </p>
        </div>
      )}
    </header>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button role="menuitem" onClick={onClick} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm hover:bg-[hsl(var(--accent))]">
      <span className="text-[hsl(var(--muted-foreground))]">{icon}</span>
      {label}
    </button>
  );
}

function Banners({ snap }: { snap: Snapshot }) {
  if (snap.signedOut) {
    return (
      <Banner tone="danger" icon={<LogIn size={16} />} title="This PC was signed out of Loom" body="Transfers are kept and continue once you sign in again.">
        <Button size="sm" variant="primary" onClick={() => api.signOut()}>Sign in again</Button>
      </Banner>
    );
  }
  if (snap.diskFull) {
    return (
      <Banner tone="danger" icon={<HardDrive size={16} />} title="Loom's drive is full" body="Uploads are paused. Free up space on the server, then resume.">
        <Button size="sm" onClick={() => api.resume(null)}>Resume</Button>
      </Banner>
    );
  }
  if (snap.offline) {
    return <Banner tone="warning" icon={<CloudOff size={16} />} title="Can't reach Loom" body="Transfers wait and continue by themselves when it's back." />;
  }
  if (snap.allPaused) {
    return <Banner tone="muted" icon={<Pause size={16} />} title="Everything is paused" body="Nothing is sent or received until you resume." />;
  }
  return null;
}

function Banner({ tone, icon, title, body, children }: { tone: "danger" | "warning" | "muted"; icon: React.ReactNode; title: string; body: string; children?: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cx(
        "mx-4 mb-3 flex items-center gap-3 rounded-lg border px-3 py-2.5",
        tone === "danger" && "border-[hsl(var(--danger)/0.35)] bg-[hsl(var(--danger)/0.07)]",
        tone === "warning" && "border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)]",
        tone === "muted" && "border-[hsl(var(--border))] bg-[hsl(var(--muted))]"
      )}
    >
      <span className={cx(tone === "danger" && "text-[hsl(var(--danger))]", tone === "warning" && "text-[hsl(var(--warning))]", tone === "muted" && "text-[hsl(var(--muted-foreground))]")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{body}</p>
      </div>
      {children}
    </div>
  );
}

function Empty({ filter }: { filter: Filter }) {
  const text: Record<Filter, [string, string]> = {
    all: ["Nothing is transferring", "Drop files on Loom, use “Upload to Loom” in File Explorer, or choose Upload."],
    uploads: ["No uploads", "Uploads you start show up here."],
    downloads: ["No downloads", "Downloads you start in Loom show up here."],
    paused: ["Nothing is paused", ""],
    attention: ["Nothing needs your attention", ""],
    done: ["No finished transfers", ""],
  };
  const [title, body] = text[filter];
  return (
    <div className="flex h-full flex-col items-center justify-center pb-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
        {filter === "attention" || filter === "done" ? <CheckCircle2 size={22} /> : <ArrowUpDown size={22} />}
      </div>
      <p className="text-sm font-medium">{title}</p>
      {body && <p className="mt-1 max-w-xs text-xs text-[hsl(var(--muted-foreground))]">{body}</p>}
      {filter === "all" && (
        <div className="mt-4 flex gap-2">
          <Button size="sm" onClick={() => api.pickUpload("files")}>
            <Upload size={14} /> Upload files
          </Button>
          <Button size="sm" onClick={() => api.pickUpload("folder")}>
            <FolderUp size={14} /> Upload a folder
          </Button>
        </div>
      )}
    </div>
  );
}

function batchStatus(b: Batch): { text: string; tone: "muted" | "primary" | "success" | "warning" | "danger" } {
  if (b.state === "cancelled") return { text: "Cancelled", tone: "muted" };
  if (isDone(b)) {
    if (b.filesFailed) return { text: `${count(b.filesFailed, "file")} failed`, tone: "danger" };
    return { text: b.direction === "upload" ? "Uploaded" : "Downloaded", tone: "success" };
  }
  if (b.filesConflict) return { text: `${count(b.filesConflict, "name")} already taken`, tone: "warning" };
  if (b.paused) return { text: "Paused", tone: "muted" };
  if (b.scanning) return { text: "Finding files…", tone: "primary" };
  if (b.filesFailed) return { text: `${count(b.filesFailed, "file")} failed`, tone: "danger" };
  if (b.bytesPerSecond > 0) return { text: speed(b.bytesPerSecond), tone: "primary" };
  return { text: "Waiting", tone: "muted" };
}

function BatchRow({ b, onChanged, onReview }: { b: Batch; onChanged: () => void; onReview: () => void }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const done = isDone(b);
  const status = batchStatus(b);
  const fraction = b.bytesTotal ? b.bytesDone / b.bytesTotal : done ? 1 : 0;
  const run = (p: Promise<unknown>) => p.then(onChanged);
  const Arrow = b.direction === "upload" ? ArrowUpFromLine : ArrowDownToLine;
  const where = b.direction === "upload" ? `to ${folderLabel(b.remoteDir)}` : `to ${b.localDir ?? "Downloads"}`;

  return (
    <li className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))]">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Hide files" : "Show files"} className="rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
          <ChevronRight size={16} className={cx("transition-transform", open && "rotate-90")} />
        </button>
        <span
          className={cx(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
            b.direction === "upload" ? "bg-[hsl(var(--primary-soft))] text-[hsl(var(--primary))]" : "bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]"
          )}
        >
          <Arrow size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="truncate text-sm font-medium" title={b.title}>{b.title}</p>
            <p className="truncate text-xs text-[hsl(var(--muted-foreground))]">{where}</p>
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <Progress value={fraction} tone={done ? (b.filesFailed ? "danger" : "success") : b.paused ? "muted" : b.filesConflict ? "warning" : "primary"} className="w-full max-w-[420px]" />
          </div>
          <p className="tabular mt-1 flex flex-wrap gap-x-3 text-xs text-[hsl(var(--muted-foreground))]">
            <span>
              {b.filesDone.toLocaleString()} of {count(b.filesTotal, "file")}
            </span>
            <span>
              {bytes(b.bytesDone)} of {bytes(b.bytesTotal)}
            </span>
            {!done && b.bytesPerSecond > 0 && <span>{timeLeft(b.bytesTotal - b.bytesDone, b.bytesPerSecond)}</span>}
            {done && b.finishedAt && <span>{ago(b.finishedAt)}</span>}
          </p>
        </div>
        <span
          className={cx(
            "tabular shrink-0 text-xs font-medium",
            status.tone === "primary" && "text-[hsl(var(--primary))]",
            status.tone === "success" && "text-[hsl(var(--success))]",
            status.tone === "warning" && "text-[hsl(var(--warning))]",
            status.tone === "danger" && "text-[hsl(var(--danger))]",
            status.tone === "muted" && "text-[hsl(var(--muted-foreground))]"
          )}
        >
          {status.text}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {b.filesConflict > 0 && (
            <Button size="sm" onClick={onReview}>
              Review
            </Button>
          )}
          {b.filesFailed > 0 && (
            <IconButton label="Retry failed files" onClick={() => run(api.retry(b.id, null))}>
              <RotateCcw size={15} />
            </IconButton>
          )}
          {!done &&
            (b.paused ? (
              <IconButton label="Resume" onClick={() => run(api.resume(b.id))}>
                <Play size={15} />
              </IconButton>
            ) : (
              <IconButton label="Pause" onClick={() => run(api.pause(b.id))}>
                <Pause size={15} />
              </IconButton>
            ))}
          {!done && (
            <IconButton label="Cancel" onClick={() => run(api.cancel(b.id, null))}>
              <X size={15} />
            </IconButton>
          )}
          <div className="relative">
            <IconButton label="More" onClick={() => setMore((m) => !m)}>
              <MoreHorizontal size={15} />
            </IconButton>
            {more && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMore(false)} />
                <div role="menu" className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-1 shadow-xl">
                  {b.direction === "upload" ? (
                    <MenuItem icon={<ExternalLink size={15} />} label="Show in Loom" onClick={() => { setMore(false); api.openMain(b.remoteDir); }} />
                  ) : (
                    <MenuItem icon={<FolderOpen size={15} />} label="Show in File Explorer" onClick={() => { setMore(false); if (b.localDir) api.reveal(b.localDir); }} />
                  )}
                  {done && <MenuItem icon={<Trash2 size={15} />} label="Remove from list" onClick={() => { setMore(false); run(api.removeBatch(b.id)); }} />}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {open && <Files batch={b} onChanged={onChanged} />}
    </li>
  );
}

function itemStatus(it: Item): { text: string; tone: string } {
  switch (it.state) {
    case "done":
      return { text: "Done", tone: "text-[hsl(var(--success))]" };
    case "running":
      return { text: it.size ? `${Math.floor((it.bytesDone / it.size) * 100)}%` : "…", tone: "text-[hsl(var(--primary))]" };
    case "waiting":
      return { text: "Retrying soon", tone: "text-[hsl(var(--warning))]" };
    case "conflict":
      return { text: "Name taken", tone: "text-[hsl(var(--warning))]" };
    case "failed":
      return { text: "Failed", tone: "text-[hsl(var(--danger))]" };
    case "skipped":
      return { text: "Skipped", tone: "text-[hsl(var(--muted-foreground))]" };
    case "cancelled":
      return { text: "Cancelled", tone: "text-[hsl(var(--muted-foreground))]" };
    case "checking":
      return { text: "Checking", tone: "text-[hsl(var(--muted-foreground))]" };
    default:
      return { text: "Waiting", tone: "text-[hsl(var(--muted-foreground))]" };
  }
}

function Files({ batch, onChanged }: { batch: Batch; onChanged: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    let alive = true;
    const load = () => api.items(batch.id, 0, limit).then((v) => alive && setItems(v));
    load();
    const t = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [batch.id, limit]);
  return (
    <div className="border-t border-[hsl(var(--border))]">
      <ul className="max-h-72 overflow-y-auto py-1">
        {items.map((it) => {
          const s = itemStatus(it);
          return (
            <li key={it.id} className="group flex items-center gap-3 px-4 py-1.5 pl-[3.25rem] text-[13px] hover:bg-[hsl(var(--accent))]">
              {it.state === "failed" ? <FileWarning size={14} className="shrink-0 text-[hsl(var(--danger))]" /> : <span className="w-[14px] shrink-0" />}
              <span className="min-w-0 flex-1 truncate" title={it.remotePath}>
                {fileName(it.remotePath)}
                {it.error && it.state !== "done" && <span className="ml-2 text-xs text-[hsl(var(--muted-foreground))]">{it.error}</span>}
              </span>
              {it.state === "running" && <Progress value={it.size ? it.bytesDone / it.size : 0} className="w-24 shrink-0" />}
              <span className="tabular w-20 shrink-0 text-right text-xs text-[hsl(var(--muted-foreground))]">{bytes(it.size)}</span>
              <span className={cx("tabular w-24 shrink-0 text-right text-xs", s.tone)}>{s.text}</span>
              {(it.state === "failed" || it.state === "waiting") && (
                <IconButton label="Retry this file" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => api.retry(batch.id, it.id).then(onChanged)}>
                  <RotateCcw size={13} />
                </IconButton>
              )}
            </li>
          );
        })}
      </ul>
      {items.length >= limit && (
        <div className="border-t border-[hsl(var(--border))] px-4 py-1.5 text-center">
          <button className="text-xs font-medium text-[hsl(var(--primary))] hover:underline" onClick={() => setLimit((l) => l + 200)}>
            Show more
          </button>
        </div>
      )}
    </div>
  );
}
