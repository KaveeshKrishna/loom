"use client";

/**
 * Choose a destination folder ("Move to…" / "Copy to…").
 * Promise-based: `const dest = await pickFolder({ title, start, exclude })`.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, FolderPlus, Home, Loader2 } from "lucide-react";
import { Dialog, Button, dialogs, validateFileName } from "@/components/ui/Dialog";
import { api } from "@/lib/client/api";
import { toast } from "@/components/ui/Toaster";
import { cn } from "@/lib/utils";

interface Req {
  title: string;
  confirmLabel: string;
  start: string;
  /** Paths that can't be chosen (the items being moved, and their subfolders) */
  exclude: string[];
  resolve: (dest: string | null) => void;
}

let current: Req | null = null;
const subs = new Set<(r: Req | null) => void>();

export function pickFolder(opts: { title: string; confirmLabel?: string; start?: string; exclude?: string[] }): Promise<string | null> {
  return new Promise((resolve) => {
    current = { title: opts.title, confirmLabel: opts.confirmLabel ?? "Choose", start: opts.start ?? "", exclude: opts.exclude ?? [], resolve };
    subs.forEach((s) => s(current));
  });
}

interface Dir {
  id: string;
  name: string;
  relativePath: string;
}

export function FolderPickerHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [path, setPath] = useState("");
  const [dirs, setDirs] = useState<Dir[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = (r: Req | null) => {
      setReq(r);
      if (r) setPath(r.start);
    };
    subs.add(s);
    return () => {
      subs.delete(s);
    };
  }, []);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ children: (Dir & { type: string })[] }>(`/api/files?path=${encodeURIComponent(p)}`);
      setDirs(data.children.filter((c) => c.type === "DIRECTORY").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })));
    } catch (err) {
      setError((err as Error).message);
      setDirs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (req) load(path);
  }, [req, path, load]);

  if (!req) return null;
  const close = (v: string | null) => {
    current = null;
    setReq(null);
    req.resolve(v);
  };
  const excluded = (p: string) => req.exclude.some((x) => p === x || p.startsWith(x + "/"));
  const crumbs = path ? path.split("/") : [];

  return (
    <Dialog
      open
      onClose={() => close(null)}
      title={req.title}
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto flex items-center gap-1.5"
            onClick={async () => {
              const name = await dialogs.prompt({ title: "New folder", defaultValue: "Untitled folder", confirmLabel: "Create", validate: validateFileName });
              if (!name) return;
              try {
                const r = await api<{ path: string }>("/api/fs/mkdir", { method: "POST", json: { parentPath: path, name } });
                setPath(r.path);
              } catch (err) {
                toast.error((err as Error).message);
              }
            }}
          >
            <FolderPlus size={15} /> New folder
          </Button>
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" disabled={excluded(path)} onClick={() => close(path)}>
            {req.confirmLabel} here
          </Button>
        </>
      }
    >
      <nav className="flex items-center gap-1 text-sm mb-3 flex-wrap">
        <button onClick={() => setPath("")} className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[hsl(var(--accent))]", !path && "font-semibold")}>
          <Home size={14} /> Home
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight size={13} className="text-[hsl(var(--muted-foreground))]" />
            <button
              onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}
              className={cn("px-1.5 py-0.5 rounded hover:bg-[hsl(var(--accent))] truncate max-w-[160px]", i === crumbs.length - 1 && "font-semibold")}
            >
              {c}
            </button>
          </span>
        ))}
      </nav>
      <div className="border rounded-lg h-72 overflow-y-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center text-[hsl(var(--muted-foreground))]">
            <Loader2 className="animate-spin" size={18} />
          </div>
        ) : error ? (
          <p className="p-4 text-sm text-red-500">{error}</p>
        ) : dirs.length === 0 ? (
          <p className="p-4 text-sm text-[hsl(var(--muted-foreground))]">No folders here</p>
        ) : (
          dirs.map((d) => {
            const disabled = excluded(d.relativePath);
            return (
              <button
                key={d.id}
                disabled={disabled}
                onClick={() => setPath(d.relativePath)}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-[hsl(var(--accent))] disabled:opacity-40 disabled:pointer-events-none"
              >
                <Folder size={16} className="text-[hsl(var(--primary))] shrink-0" />
                <span className="truncate flex-1">{d.name}</span>
                <ChevronRight size={14} className="text-[hsl(var(--muted-foreground))]" />
              </button>
            );
          })
        )}
      </div>
    </Dialog>
  );
}
