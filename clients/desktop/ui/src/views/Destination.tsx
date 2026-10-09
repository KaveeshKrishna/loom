/**
 * "Upload to Loom" from File Explorer / Send to / the tray: choose the
 * folder in Loom, and what to do if a name is already taken.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, FolderPlus, Home, Loader2, Clock, FileText } from "lucide-react";
import { api, listen, type FolderListing, type OnConflict, type PendingUpload } from "../lib/ipc";
import { Button, Select, cx } from "../components/ui";
import { folderLabel } from "../lib/format";

const POLICIES: { value: OnConflict; label: string }[] = [
  { value: "ask", label: "Ask me" },
  { value: "keep_both", label: "Keep both (add a number)" },
  { value: "replace", label: "Replace (old one to Trash)" },
  { value: "skip", label: "Skip it" },
];

export function Destination() {
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [policy, setPolicy] = useState<OnConflict>("ask");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const l = await api.listFolder(p);
      setListing(l);
      setPath(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const load = () =>
      api.pendingUpload().then((p) => {
        setPending(p);
        open(p?.destDir ?? "");
      });
    load();
    api.recentDestinations().then(setRecent);
    const off = listen("pending-upload", load);
    return () => {
      off.then((f) => f());
    };
  }, [open]);

  const crumbs = path ? path.split("/") : [];
  const names = pending?.names ?? [];
  const title = pending ? (pending.count === 1 ? `Upload “${names[0]}”` : `Upload ${pending.count.toLocaleString()} items`) : "Upload to Loom";

  const createFolder = async () => {
    const name = naming?.trim();
    if (!name) return setNaming(null);
    try {
      const created = await api.createFolder(path, name);
      setNaming(null);
      await open(created);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="px-5 pt-4 pb-3">
        <h1 className="truncate font-[family-name:var(--font-display)] text-lg font-semibold" title={title}>
          {title}
        </h1>
        {pending && pending.count > 1 && (
          <p className="mt-0.5 truncate text-xs text-[hsl(var(--muted-foreground))]">
            {names.slice(0, 3).join(", ")}
            {pending.count > 3 && ` and ${(pending.count - 3).toLocaleString()} more`}
          </p>
        )}
      </header>

      {recent.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-5 pb-3">
          {recent.slice(0, 4).map((r) => (
            <button
              key={r}
              onClick={() => open(r)}
              className={cx(
                "inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border px-2.5 text-xs",
                r === path ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary-soft))] text-[hsl(var(--primary))]" : "border-[hsl(var(--border-strong))] hover:bg-[hsl(var(--accent))]"
              )}
              title={folderLabel(r)}
            >
              <Clock size={12} className="shrink-0" />
              <span className="truncate">{r.split("/").pop() || "Home"}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mx-5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))]">
        <nav aria-label="Folder" className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[hsl(var(--border))] px-2 text-sm">
          <button onClick={() => open("")} className="flex h-7 items-center gap-1 rounded px-1.5 hover:bg-[hsl(var(--accent))]" aria-label="Home">
            <Home size={14} />
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex shrink-0 items-center">
              <ChevronRight size={14} className="text-[hsl(var(--muted-foreground))]" />
              <button onClick={() => open(crumbs.slice(0, i + 1).join("/"))} className={cx("h-7 rounded px-1.5 hover:bg-[hsl(var(--accent))]", i === crumbs.length - 1 && "font-medium")}>
                {c}
              </button>
            </span>
          ))}
          <div className="flex-1" />
          <button onClick={() => setNaming("")} className="flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-[13px] hover:bg-[hsl(var(--accent))]">
            <FolderPlus size={14} /> New folder
          </button>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {naming != null && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createFolder();
              }}
              className="flex items-center gap-2.5 px-3 py-1.5"
            >
              <Folder size={16} className="text-[hsl(var(--primary))]" />
              <input
                autoFocus
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onBlur={createFolder}
                onKeyDown={(e) => e.key === "Escape" && setNaming(null)}
                placeholder="Folder name"
                className="selectable h-7 flex-1 rounded border border-[hsl(var(--primary))] bg-transparent px-2 text-sm outline-none"
              />
            </form>
          )}
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 size={18} className="animate-spin text-[hsl(var(--muted-foreground))]" />
            </div>
          ) : error ? (
            <p className="px-4 py-6 text-center text-sm text-[hsl(var(--danger))]">{error}</p>
          ) : listing && listing.folders.length === 0 && naming == null ? (
            <p className="px-4 py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">No folders here. Files will go into {folderLabel(path)}.</p>
          ) : (
            listing?.folders.map((f) => (
              <button key={f.path} onDoubleClick={() => open(f.path)} onClick={() => open(f.path)} className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm hover:bg-[hsl(var(--accent))]">
                <Folder size={16} className="shrink-0 text-[hsl(var(--primary))]" />
                <span className="flex-1 truncate">{f.name}</span>
                <ChevronRight size={14} className="text-[hsl(var(--muted-foreground))]" />
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 px-5 pt-3">
        <span className="flex items-center gap-2 text-[13px] text-[hsl(var(--muted-foreground))]">
          <FileText size={14} />
          If a file with the same name is already there
        </span>
        <Select label="If a file with the same name is already there" value={policy} onChange={setPolicy} options={POLICIES} />
      </div>
      <footer className="flex items-center justify-end gap-2 px-5 py-4">
        <Button onClick={() => api.cancelPendingUpload()}>Cancel</Button>
        <Button
          variant="primary"
          disabled={busy || !pending || listing?.canWrite === false}
          title={listing?.canWrite === false ? "You can't upload into this folder" : undefined}
          onClick={async () => {
            setBusy(true);
            await api.confirmUpload(path, policy);
          }}
        >
          Upload to {path ? path.split("/").pop() : "Home"}
        </Button>
      </footer>
    </div>
  );
}
