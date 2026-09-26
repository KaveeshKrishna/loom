/* eslint-disable @next/next/no-img-element */
"use client";

/**
 * Full-screen viewer for everything in a folder/collection.
 *
 *  - Photos: fast 1920px preview first, "Original" loads the full file;
 *    wheel / pinch / double-click zoom, drag to pan, rotate, slideshow.
 *  - Videos: played straight from disk when the browser supports the codec,
 *    otherwise through on-demand HLS (hls.js is only loaded when needed).
 *  - Audio: player with auto-advance to the next track.
 *  - PDFs: the browser's own PDF viewer.
 *  - Text, code and Markdown: highlighted viewer with an editor.
 *  - Everything else: a download card.
 *
 * Rendered in a portal on <body>, so clicks and drags inside it never reach
 * the file grid underneath.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { X, Download, RotateCw, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Play, Pause, Info, Loader2, AlertTriangle, Maximize2, FileQuestion, Music } from "lucide-react";
import type { ErrorData } from "hls.js";
import { getFileCategory, formatBytes, cn } from "@/lib/utils";
import type { LNode } from "@/lib/client/types";
import { thumbUrl, previewUrl, serveUrl } from "@/lib/client/types";
import { isEditableName } from "@/lib/text-files";
import { dialogs } from "@/components/ui/Dialog";
import { FileIcon } from "@/components/files/FileIcon";

const TextViewer = dynamic(() => import("./TextViewer"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center text-white/60">
      <Loader2 className="animate-spin" />
    </div>
  ),
});

export interface MediaSibling {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string | null;
  cachePath?: string | null;
}

interface Props {
  nodes: LNode[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  onShowDetails?: (node: LNode) => void;
  startEditing?: boolean;
}

type Kind = "image" | "video" | "audio" | "pdf" | "text" | "other";

function kindOf(n: LNode): Kind {
  const cat = getFileCategory(n.mimeType, n.name);
  if (cat === "image") return "image";
  if (cat === "video") return "video";
  if (cat === "audio") return "audio";
  if (n.mimeType === "application/pdf" || /\.pdf$/i.test(n.name)) return "pdf";
  if (isEditableName(n.name, n.mimeType)) return "text";
  return "other";
}

export function MediaViewer({ nodes, index, onIndexChange, onClose, onShowDetails, startEditing }: Props) {
  const node = nodes[index];
  const kind = node ? kindOf(node) : "other";
  const [slideshow, setSlideshow] = useState(false);
  const dirtyRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const guard = useCallback(async () => {
    if (!dirtyRef.current) return true;
    return dialogs.confirm({ title: "Discard unsaved changes?", message: "Your edits to this file haven't been saved.", confirmLabel: "Discard", danger: true });
  }, []);

  const go = useCallback(
    async (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= nodes.length) return;
      if (!(await guard())) return;
      dirtyRef.current = false;
      onIndexChange(next);
    },
    [index, nodes.length, onIndexChange, guard]
  );

  const close = useCallback(async () => {
    if (await guard()) onClose();
  }, [guard, onClose]);

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, .cm-editor, [role=dialog]")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "i" && node) onShowDetails?.(node);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, close, onShowDetails, node]);

  // Slideshow (images only, 4 s per photo)
  useEffect(() => {
    if (!slideshow) return;
    const t = setTimeout(() => {
      const next = nodes.findIndex((n, i) => i > index && kindOf(n) === "image");
      if (next === -1) setSlideshow(false);
      else onIndexChange(next);
    }, 4000);
    return () => clearTimeout(t);
  }, [slideshow, index, nodes, onIndexChange]);

  // Lock page scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Swipe between items on touch screens (when not zoomed)
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const zoomedRef = useRef(false);

  if (!mounted || !node) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-black flex flex-col select-none"
      role="dialog"
      aria-modal="true"
      aria-label={node.name}
      onTouchStart={(e) => {
        if (e.touches.length === 1) touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      }}
      onTouchEnd={(e) => {
        const s = touch.current;
        touch.current = null;
        if (!s || zoomedRef.current || kind === "text" || kind === "pdf") return;
        const dx = e.changedTouches[0].clientX - s.x;
        const dy = e.changedTouches[0].clientY - s.y;
        if (Date.now() - s.t < 600 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
      }}
    >
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 sm:px-4 h-14 shrink-0 text-white bg-gradient-to-b from-black/60 to-transparent">
        <button onClick={close} className="p-2 rounded-full hover:bg-white/10" aria-label="Close (Esc)">
          <X size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{node.name}</p>
          <p className="text-[11px] text-white/60">
            {index + 1} / {nodes.length}
            {node.size != null && ` · ${formatBytes(Number(node.size))}`}
          </p>
        </div>
        {kind === "image" && (
          <button onClick={() => setSlideshow((s) => !s)} className="p-2 rounded-full hover:bg-white/10" aria-label={slideshow ? "Pause slideshow" : "Start slideshow"} title="Slideshow">
            {slideshow ? <Pause size={18} /> : <Play size={18} />}
          </button>
        )}
        {onShowDetails && (
          <button onClick={() => onShowDetails(node)} className="p-2 rounded-full hover:bg-white/10" aria-label="Details (i)" title="Details (i)">
            <Info size={18} />
          </button>
        )}
        <a href={serveUrl(node.relativePath, true)} className="p-2 rounded-full hover:bg-white/10" aria-label="Download" title="Download">
          <Download size={18} />
        </a>
      </div>

      {/* Stage */}
      <div className="flex-1 min-h-0 relative flex items-center justify-center px-2 sm:px-14 pb-2">
        {kind === "image" && <ImageStage key={node.id} node={node} onZoomChange={(z) => (zoomedRef.current = z > 1)} />}
        {kind === "video" && <VideoStage key={node.id} node={node} />}
        {kind === "audio" && <AudioStage key={node.id} node={node} onEnded={() => {
          const next = nodes.findIndex((n, i) => i > index && kindOf(n) === "audio");
          if (next !== -1) onIndexChange(next);
        }} />}
        {kind === "pdf" && (
          <iframe key={node.id} src={serveUrl(node.relativePath)} title={node.name} className="w-full h-full max-w-5xl bg-white rounded-lg border-0" />
        )}
        {kind === "text" && (
          <div className="w-full h-full max-w-5xl">
            <TextViewer
              key={node.id}
              relativePath={node.relativePath}
              name={node.name}
              startEditing={startEditing}
              onDirtyChange={(d) => (dirtyRef.current = d)}
            />
          </div>
        )}
        {kind === "other" && <OtherStage node={node} />}

        {index > 0 && (
          <button onClick={() => go(-1)} className="hidden sm:flex absolute left-2 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white" aria-label="Previous (←)">
            <ChevronLeft size={22} />
          </button>
        )}
        {index < nodes.length - 1 && (
          <button onClick={() => go(1)} className="hidden sm:flex absolute right-2 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white" aria-label="Next (→)">
            <ChevronRight size={22} />
          </button>
        )}
      </div>

      {/* Filmstrip (windowed: only nearby thumbnails are rendered) */}
      {nodes.length > 1 && kind !== "text" && <Filmstrip nodes={nodes} index={index} onPick={(i) => go(i - index)} />}
    </div>,
    document.body
  );
}

// ─── Images ──────────────────────────────────────────────────────────────────

function ImageStage({ node, onZoomChange }: { node: LNode; onZoomChange: (z: number) => void }) {
  const preview = previewUrl(node);
  const [original, setOriginal] = useState(!preview);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rot, setRot] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const src = original ? serveUrl(node.relativePath) : preview!;

  useEffect(() => {
    onZoomChange(zoom);
  }, [zoom, onZoomChange]);
  const setZ = (z: number) => {
    const c = Math.min(8, Math.max(1, z));
    setZoom(c);
    if (c === 1) setPan({ x: 0, y: 0 });
  };

  // Non-passive wheel + pinch listeners (React's are passive and can't preventDefault).
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => {
        const c = Math.min(8, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        if (c === 1) setPan({ x: 0, y: 0 });
        return c;
      });
    };
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch.current = { d: dist(e.touches), z: zoomRef.current };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinch.current) {
        e.preventDefault();
        const c = Math.min(8, Math.max(1, pinch.current.z * (dist(e.touches) / pinch.current.d)));
        setZoom(c);
        if (c === 1) setPan({ x: 0, y: 0 });
      }
    };
    const onTouchEnd = () => (pinch.current = null);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, []);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  return (
    <div className="w-full h-full flex flex-col">
      <div
        ref={boxRef}
        className={cn("flex-1 min-h-0 flex items-center justify-center overflow-hidden", zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in")}
        onDoubleClick={() => setZ(zoom > 1 ? 1 : 2.5)}
        onPointerDown={(e) => {
          if (zoom <= 1 || e.pointerType === "touch" && pinch.current) return;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPan({ x: drag.current.px + (e.clientX - drag.current.x) / zoom, y: drag.current.py + (e.clientY - drag.current.y) / zoom });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        {!loaded && !failed && preview && !original && <img src={thumbUrl(node) ?? preview} alt="" className="absolute max-w-full max-h-full object-contain blur-md opacity-60" />}
        {failed ? (
          <div className="text-white/70 flex flex-col items-center gap-2 text-center px-6">
            <AlertTriangle size={30} className="text-amber-400" />
            <p>This image can&apos;t be shown in the browser.</p>
            <a href={serveUrl(node.relativePath, true)} className="underline text-sm">Download it instead</a>
          </div>
        ) : (
          <img
            src={src}
            alt={node.name}
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => (original ? setFailed(true) : setOriginal(true))}
            className={cn("max-w-full max-h-full object-contain transition-opacity", loaded ? "opacity-100" : "opacity-0")}
            style={{ transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px) rotate(${rot}deg)`, transition: drag.current ? "none" : "transform 0.12s ease-out" }}
          />
        )}
        {!loaded && !failed && <Loader2 className="absolute animate-spin text-white/50" />}
      </div>
      <div className="flex items-center justify-center gap-1 pt-2 text-white">
        <button onClick={() => setZ(zoom / 1.5)} className="p-2 rounded-full hover:bg-white/10" aria-label="Zoom out"><ZoomOut size={17} /></button>
        <span className="text-xs w-12 text-center text-white/70">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZ(zoom * 1.5)} className="p-2 rounded-full hover:bg-white/10" aria-label="Zoom in"><ZoomIn size={17} /></button>
        <button onClick={() => setRot((r) => (r + 90) % 360)} className="p-2 rounded-full hover:bg-white/10" aria-label="Rotate"><RotateCw size={17} /></button>
        {!original && preview && (
          <button onClick={() => { setLoaded(false); setOriginal(true); }} className="ml-2 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs bg-white/10 hover:bg-white/20" title="Load the full-resolution original">
            <Maximize2 size={13} /> Original
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Video ───────────────────────────────────────────────────────────────────

function VideoStage({ node }: { node: LNode }) {
  const [probe, setProbe] = useState<{ compatible: boolean; durationSeconds: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/files/hls/${node.id}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.error || "Can't play this video")))))
      .then((d) => setProbe({ compatible: d.compatible, durationSeconds: d.durationSeconds }))
      .catch((e) => e.name !== "AbortError" && setError(e.message));
    return () => ctrl.abort();
  }, [node.id]);

  const poster = previewUrl(node) ?? undefined;
  if (error) return <PlaybackError node={node} message={error} />;
  if (!probe) return <Loader2 className="animate-spin text-white/60" />;
  if (probe.compatible) {
    return (
      <video
        key={node.id}
        src={serveUrl(node.relativePath)}
        poster={poster}
        controls
        autoPlay
        playsInline
        className="max-w-full max-h-full rounded-lg bg-black"
        onError={() => setError("The browser couldn't play this video.")}
      />
    );
  }
  return <HlsPlayer fileNodeId={node.id} poster={poster} onFatal={setError} />;
}

function HlsPlayer({ fileNodeId, poster, onFatal }: { fileNodeId: string; poster?: string; onFatal: (msg: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [preparing, setPreparing] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const onFatalRef = useRef(onFatal);
  onFatalRef.current = onFatal;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const src = `/api/files/hls/${fileNodeId}/manifest.m3u8`;
    let destroyed = false;
    let hlsInstance: { destroy: () => void } | null = null;

    const onPlaying = () => {
      setPreparing(false);
      setBuffering(false);
    };
    const onWaiting = () => setBuffering(true);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("loadeddata", onPlaying);

    if (video.canPlayType("application/vnd.apple.mpegurl") && !("MediaSource" in window)) {
      video.src = src; // Safari on iOS: native HLS
    } else {
      import("hls.js").then(({ default: Hls }) => {
        if (destroyed) return;
        if (!Hls.isSupported()) {
          video.src = src;
          return;
        }
        let mediaErrors = 0;
        const hls = new Hls({
          fragLoadingTimeOut: 60_000,
          manifestLoadingTimeOut: 30_000,
          fragLoadingMaxRetry: 8,
          fragLoadingRetryDelay: 1000,
          maxBufferLength: 30,
        });
        hlsInstance = hls;
        hls.on(Hls.Events.ERROR, (_e: unknown, data: ErrorData) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaErrors++ < 2) hls.recoverMediaError();
          else onFatalRef.current("This video couldn't be converted for playback.");
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        video.play().catch(() => {});
      });
    }
    return () => {
      destroyed = true;
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("loadeddata", onPlaying);
      hlsInstance?.destroy();
    };
  }, [fileNodeId]);

  return (
    <div className="relative max-w-full max-h-full flex items-center justify-center">
      <video ref={videoRef} poster={poster} controls playsInline autoPlay className="max-w-full max-h-[calc(100svh-10rem)] rounded-lg bg-black" />
      {(preparing || buffering) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80 pointer-events-none">
          <Loader2 className="animate-spin" />
          {preparing && <p className="text-xs bg-black/50 px-2 py-1 rounded">Preparing video — converting for your browser…</p>}
        </div>
      )}
    </div>
  );
}

function PlaybackError({ node, message }: { node: LNode; message: string }) {
  return (
    <div className="text-white/80 flex flex-col items-center gap-2 text-center px-6">
      <AlertTriangle size={30} className="text-amber-400" />
      <p>{message}</p>
      <a href={serveUrl(node.relativePath, true)} className="underline text-sm">Download the file</a>
    </div>
  );
}

// ─── Audio ───────────────────────────────────────────────────────────────────

function AudioStage({ node, onEnded }: { node: LNode; onEnded: () => void }) {
  const cover = previewUrl(node);
  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-md text-white">
      <div className="w-56 h-56 rounded-2xl bg-white/10 flex items-center justify-center overflow-hidden shadow-2xl">
        {cover ? <img src={cover} alt="" className="w-full h-full object-cover" /> : <Music size={72} strokeWidth={1.2} className="text-white/60" />}
      </div>
      <p className="text-base font-medium text-center break-all">{node.name}</p>
      <audio key={node.id} src={serveUrl(node.relativePath)} controls autoPlay className="w-full" onEnded={onEnded} />
    </div>
  );
}

// ─── Other ───────────────────────────────────────────────────────────────────

function OtherStage({ node }: { node: LNode }) {
  return (
    <div className="bg-[hsl(var(--card))] text-[hsl(var(--foreground))] rounded-2xl p-8 flex flex-col items-center gap-3 max-w-sm text-center shadow-2xl">
      <div className="w-20 h-20 rounded-2xl bg-[hsl(var(--accent))] flex items-center justify-center">
        <FileIcon mimeType={node.mimeType} type="FILE" size={40} name={node.name} />
      </div>
      <p className="font-medium break-all">{node.name}</p>
      <p className="text-sm text-[hsl(var(--muted-foreground))] flex items-center gap-1.5">
        <FileQuestion size={14} /> No preview for this type of file
      </p>
      <a href={serveUrl(node.relativePath, true)} className="mt-2 px-4 py-2 rounded-lg bg-[hsl(var(--primary))] text-white text-sm font-medium flex items-center gap-2">
        <Download size={15} /> Download{node.size != null ? ` (${formatBytes(Number(node.size))})` : ""}
      </a>
    </div>
  );
}

// ─── Filmstrip ───────────────────────────────────────────────────────────────

function Filmstrip({ nodes, index, onPick }: { nodes: LNode[]; index: number; onPick: (i: number) => void }) {
  const WINDOW = 40;
  const start = Math.max(0, index - WINDOW);
  const end = Math.min(nodes.length, index + WINDOW + 1);
  const activeRef = useRef<HTMLButtonElement>(null);
  const items = useMemo(() => nodes.slice(start, end), [nodes, start, end]);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [index]);
  return (
    <div className="shrink-0 h-20 flex items-center gap-1.5 px-4 overflow-x-auto no-scrollbar bg-black/60">
      {items.map((n, k) => {
        const i = start + k;
        const t = thumbUrl(n);
        const active = i === index;
        return (
          <button
            key={n.id}
            ref={active ? activeRef : undefined}
            onClick={() => onPick(i)}
            title={n.name}
            className={cn("shrink-0 w-14 h-14 rounded-md overflow-hidden border-2 transition-all bg-white/10 flex items-center justify-center", active ? "border-white scale-105" : "border-transparent opacity-60 hover:opacity-90")}
          >
            {t ? <img src={t} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" /> : <FileIcon mimeType={n.mimeType} type="FILE" size={20} name={n.name} className="!text-white/70" />}
          </button>
        );
      })}
    </div>
  );
}
