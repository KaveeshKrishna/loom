"use client";

/**
 * The public page behind a share link (/s/<token>). No account needed.
 * Shows a password prompt if the link is protected, then either the shared
 * file (with a preview) or the shared folder (browsable, with previews and a
 * ZIP download when the link allows downloads).
 */

import { useCallback, useEffect, useState } from "react";
import { Download, Folder, Lock, Loader2, ChevronRight, X, AlertTriangle, Home } from "lucide-react";
import { formatBytes, formatDate, getFileCategory, cn } from "@/lib/utils";
import { FileIcon } from "@/components/files/FileIcon";

interface Info {
  name: string;
  type: "FILE" | "DIRECTORY";
  locked: boolean;
  mimeType?: string | null;
  size?: string | null;
  modifiedAt?: string | null;
  allowDownload?: boolean;
  expiresAt?: string | null;
}

interface Child {
  id: string;
  name: string;
  type: "FILE" | "DIRECTORY";
  mimeType: string | null;
  size: string | null;
  modifiedAt: string | null;
  path: string;
  hasThumb: boolean;
}

export function SharePage({ token }: { token: string }) {
  const base = `/api/share/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [children, setChildren] = useState<Child[] | null>(null);
  const [open, setOpen] = useState<Child | null>(null);

  const loadInfo = useCallback(async () => {
    try {
      const r = await fetch(base, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "This link doesn't work");
      setInfo(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base]);

  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  useEffect(() => {
    if (!info || info.locked || info.type !== "DIRECTORY") return;
    setChildren(null);
    fetch(`${base}/list?path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setChildren((d.children ?? []).sort((a: Child, b: Child) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "DIRECTORY" ? -1 : 1))))
      .catch(() => setChildren([]));
  }, [info, path, base]);

  const fileUrl = (p: string, download = false) => `${base}/file?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`;

  return (
    <div className="min-h-svh flex flex-col bg-[hsl(var(--background))]">
      <header className="h-14 border-b flex items-center gap-3 px-4 sm:px-6">
        <div className="w-7 h-7 rounded-lg bg-[hsl(var(--primary))] flex items-center justify-center shrink-0">
          <span className="text-white text-sm font-bold">L</span>
        </div>
        <p className="text-sm font-medium truncate flex-1">{info?.name ?? "Shared with you"}</p>
        {info && !info.locked && info.allowDownload && (
          <a
            href={info.type === "DIRECTORY" ? `${base}/zip?path=${encodeURIComponent(path)}` : fileUrl("", true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[hsl(var(--primary))] text-white text-sm font-medium"
          >
            <Download size={15} /> {info.type === "DIRECTORY" ? "Download all" : "Download"}
          </a>
        )}
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-6">
        {error ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <AlertTriangle size={36} className="text-amber-500 mb-3" />
            <p className="font-medium">{error}</p>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">Ask the person who shared it for a new link.</p>
          </div>
        ) : !info ? (
          <div className="flex justify-center py-24 text-[hsl(var(--muted-foreground))]">
            <Loader2 className="animate-spin" />
          </div>
        ) : info.locked ? (
          <Unlock base={base} name={info.name} onUnlocked={loadInfo} />
        ) : info.type === "FILE" ? (
          <FilePreview
            name={info.name}
            mimeType={info.mimeType ?? null}
            src={fileUrl("")}
            thumb={`${base}/thumb?path=&size=preview`}
            size={info.size}
            modifiedAt={info.modifiedAt}
            downloadUrl={info.allowDownload ? fileUrl("", true) : null}
          />
        ) : (
          <>
            <nav className="flex items-center gap-1 text-sm mb-4 flex-wrap">
              <button onClick={() => setPath("")} className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[hsl(var(--accent))]">
                <Home size={14} /> {info.name}
              </button>
              {path.split("/").filter(Boolean).map((seg, i, arr) => (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight size={13} className="text-[hsl(var(--muted-foreground))]" />
                  <button onClick={() => setPath(arr.slice(0, i + 1).join("/"))} className="px-1.5 py-0.5 rounded hover:bg-[hsl(var(--accent))]">
                    {seg}
                  </button>
                </span>
              ))}
            </nav>
            {!children ? (
              <div className="flex justify-center py-16 text-[hsl(var(--muted-foreground))]">
                <Loader2 className="animate-spin" />
              </div>
            ) : children.length === 0 ? (
              <p className="text-center text-sm text-[hsl(var(--muted-foreground))] py-16">This folder is empty</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {children.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => (c.type === "DIRECTORY" ? setPath(c.path) : setOpen(c))}
                    className="group flex flex-col gap-2 p-2.5 rounded-xl border bg-[hsl(var(--card))] hover:shadow-md text-left"
                  >
                    <div className="aspect-square rounded-lg bg-[hsl(var(--accent))] flex items-center justify-center overflow-hidden">
                      {c.hasThumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`${base}/thumb?path=${encodeURIComponent(c.path)}`} alt="" loading="lazy" className="w-full h-full object-cover" />
                      ) : c.type === "DIRECTORY" ? (
                        <Folder size={40} strokeWidth={1.4} className="text-[hsl(var(--primary))]" />
                      ) : (
                        <FileIcon mimeType={c.mimeType} type={c.type} size={32} name={c.name} />
                      )}
                    </div>
                    <p className="text-xs font-medium truncate">{c.name}</p>
                    <p className="text-[11px] text-[hsl(var(--muted-foreground))] -mt-1">{c.type === "FILE" && c.size ? formatBytes(c.size) : ""}</p>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <footer className="py-4 text-center text-xs text-[hsl(var(--muted-foreground))]">
        Shared from a private Loom server{info?.expiresAt ? ` · link expires ${formatDate(info.expiresAt)}` : ""}
      </footer>

      {open && info && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col" role="dialog" aria-modal="true">
          <div className="flex items-center gap-3 px-4 h-14 text-white">
            <button onClick={() => setOpen(null)} className="p-2 rounded-full hover:bg-white/10" aria-label="Close">
              <X size={20} />
            </button>
            <p className="flex-1 text-sm truncate">{open.name}</p>
            {info.allowDownload && (
              <a href={fileUrl(open.path, true)} className="p-2 rounded-full hover:bg-white/10" aria-label="Download">
                <Download size={18} />
              </a>
            )}
          </div>
          <div className="flex-1 min-h-0 flex items-center justify-center p-4">
            <FilePreview
              dark
              name={open.name}
              mimeType={open.mimeType}
              src={fileUrl(open.path)}
              thumb={open.hasThumb ? `${base}/thumb?path=${encodeURIComponent(open.path)}&size=preview` : null}
              size={open.size}
              modifiedAt={open.modifiedAt}
              downloadUrl={info.allowDownload ? fileUrl(open.path, true) : null}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Unlock({ base, name, onUnlocked }: { base: string; name: string; onUnlocked: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="max-w-sm mx-auto mt-16 bg-[hsl(var(--card))] border rounded-2xl p-6 flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const r = await fetch(`${base}/unlock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
        setBusy(false);
        if (r.ok) onUnlocked();
        else setErr((await r.json().catch(() => ({}))).error || "Wrong password");
      }}
    >
      <Lock size={28} className="text-[hsl(var(--primary))]" />
      <p className="font-medium">&ldquo;{name}&rdquo; is password protected</p>
      <input
        type="password"
        autoFocus
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="Password"
        className="px-3 py-2 rounded-lg border bg-[hsl(var(--background))] text-sm focus:outline-none focus:border-[hsl(var(--primary))]"
      />
      {err && <p className="text-xs text-red-500">{err}</p>}
      <button disabled={!pw || busy} className="px-4 py-2 rounded-lg bg-[hsl(var(--primary))] text-white text-sm font-medium disabled:opacity-50">
        {busy ? "Checking…" : "Open"}
      </button>
    </form>
  );
}

function FilePreview({
  name,
  mimeType,
  src,
  thumb,
  size,
  modifiedAt,
  downloadUrl,
  dark,
}: {
  name: string;
  mimeType: string | null;
  src: string;
  thumb: string | null;
  size?: string | null;
  modifiedAt?: string | null;
  downloadUrl: string | null;
  dark?: boolean;
}) {
  const cat = getFileCategory(mimeType, name);
  const [imgSrc, setImgSrc] = useState<string | null>(thumb ?? src);
  const [failed, setFailed] = useState(false);
  if (cat === "image" && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imgSrc ?? src}
        alt={name}
        onError={() => (imgSrc !== src ? setImgSrc(src) : setFailed(true))}
        className="max-w-full max-h-[80svh] object-contain rounded-lg mx-auto"
      />
    );
  }
  if (cat === "video") return <video src={src} controls playsInline className="max-w-full max-h-[80svh] rounded-lg mx-auto bg-black" poster={thumb ?? undefined} />;
  if (cat === "audio") return <audio src={src} controls className="w-full max-w-md mx-auto" />;
  if (mimeType === "application/pdf") return <iframe src={src} title={name} className="w-full h-[80svh] rounded-lg bg-white border-0" />;
  return (
    <div className={cn("max-w-sm mx-auto rounded-2xl p-8 flex flex-col items-center gap-3 text-center border", dark ? "bg-[hsl(var(--card))]" : "bg-[hsl(var(--card))]")}>
      <FileIcon mimeType={mimeType} type="FILE" size={44} name={name} />
      <p className="font-medium break-all">{name}</p>
      <p className="text-sm text-[hsl(var(--muted-foreground))]">
        {size ? formatBytes(size) : ""}
        {modifiedAt ? ` · ${formatDate(modifiedAt)}` : ""}
      </p>
      {downloadUrl ? (
        <a href={downloadUrl} className="mt-2 px-4 py-2 rounded-lg bg-[hsl(var(--primary))] text-white text-sm font-medium flex items-center gap-2">
          <Download size={15} /> Download
        </a>
      ) : (
        <p className="text-xs text-[hsl(var(--muted-foreground))]">No preview available, and downloads are disabled for this link.</p>
      )}
    </div>
  );
}
