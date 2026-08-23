/* eslint-disable @next/next/no-img-element */
"use client";

import React, { useEffect, useCallback, useState, useRef, useLayoutEffect } from "react";
import { X, Download, RotateCw, ChevronLeft, ChevronRight, WifiOff, FileVideo2, Image as ImageIcon } from "lucide-react";
import { getFileCategory } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MediaSibling {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string | null;
  cachePath?: string | null;
}

interface MediaViewerProps {
  relativePath: string;
  name: string;
  mimeType: string | null;
  cachePath?: string | null;
  onClose: () => void;
  siblings?: MediaSibling[];
  currentId?: string;
  onNavigateTo?: (sibling: MediaSibling) => void;
  // legacy compat props
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

type ViewerState = "loading" | "ready" | "offline" | "error";

// ─── Main Component ──────────────────────────────────────────────────────────

export function MediaViewer({
  relativePath, name, mimeType, cachePath,
  onClose,
  siblings, currentId, onNavigateTo,
  onPrev: legacyPrev, onNext: legacyNext, hasPrev: legacyHasPrev, hasNext: legacyHasNext,
}: MediaViewerProps) {
  const [state, setState] = useState<ViewerState>("loading");
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  // null = not yet probed, false = fine, true = needs transcode
  const [needsTranscode, setNeedsTranscode] = useState<boolean | null>(null);

  const category = getFileCategory(mimeType, name);
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const isUnsupportedVideo = category === "video" && ["mpg", "mpeg", "avi", "mkv", "wmv", "flv"].includes(ext);
  const serveSrc = `/api/files/serve?path=${encodeURIComponent(relativePath)}`;
  const transcodeSrc = `/api/files/transcode?path=${encodeURIComponent(relativePath)}`;
  const src = (category === "image" || category === "video") && cachePath
    ? `/api/cache/${cachePath}`
    : serveSrc;

  // Reset state when file changes
  useEffect(() => {
    setState("loading");
    setZoom(1);
    setRotation(0);
    setNeedsTranscode(null);
  }, [relativePath]);

  // Probe video codec — transcode anything browsers can't natively play
  useEffect(() => {
    if (category !== "video" || isUnsupportedVideo) return;

    // Codecs that all modern browsers can play natively in <video>
    const BROWSER_NATIVE_CODECS = ["h264", "avc1", "vp8", "vp9", "av1", "theora"];

    // Probe the actual codec via ffprobe HEAD request
    fetch(`/api/files/transcode?path=${encodeURIComponent(relativePath)}`, { method: "HEAD" })
      .then((res) => {
        const codec = (res.headers.get("X-Video-Codec") ?? "").toLowerCase();
        if (!codec || codec === "unknown") {
          // Can't determine — try playing directly, fall back only on error
          setNeedsTranscode(false);
          return;
        }
        const isNative = BROWSER_NATIVE_CODECS.some((c) => codec.includes(c));
        setNeedsTranscode(!isNative);
      })
      .catch(() => setNeedsTranscode(false));
  }, [relativePath, category, isUnsupportedVideo]);

  // ── Navigation helpers ────────────────────────────────────────────────────
  const siblingIndex = siblings && currentId
    ? siblings.findIndex((s) => s.id === currentId)
    : -1;

  const hasPrev = siblings ? siblingIndex > 0 : (legacyHasPrev ?? false);
  const hasNext = siblings ? siblingIndex < (siblings.length - 1) : (legacyHasNext ?? false);

  const goPrev = useCallback(() => {
    if (siblings && siblingIndex > 0 && onNavigateTo) {
      onNavigateTo(siblings[siblingIndex - 1]);
    } else if (legacyPrev) {
      legacyPrev();
    }
  }, [siblings, siblingIndex, onNavigateTo, legacyPrev]);

  const goNext = useCallback(() => {
    if (siblings && siblingIndex < siblings.length - 1 && onNavigateTo) {
      onNavigateTo(siblings[siblingIndex + 1]);
    } else if (legacyNext) {
      legacyNext();
    }
  }, [siblings, siblingIndex, onNavigateTo, legacyNext]);

  // ── Keyboard handling ─────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && hasPrev) goPrev();
      if (e.key === "ArrowRight" && hasNext) goNext();
    },
    [onClose, goPrev, goNext, hasPrev, hasNext]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // ── Touch gesture handling ────────────────────────────────────────────────
  const touchStartRef = useRef<{ x: number; y: number; dist: number; startZoom: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        dist: 0,
        startZoom: zoom,
      };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchStartRef.current = {
        x: 0,
        y: 0,
        dist: Math.sqrt(dx * dx + dy * dy),
        startZoom: zoom,
      };
    }
  }, [zoom]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current || e.touches.length !== 2) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const scale = dist / touchStartRef.current.dist;
    setZoom(Math.max(1, Math.min(touchStartRef.current.startZoom * scale, 5)));
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current || e.changedTouches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
    const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
    // Swipe navigation — only when not pinch-zoomed, and clear horizontal swipe
    if (zoom <= 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && hasNext) goNext();
      if (dx > 0 && hasPrev) goPrev();
    }
    touchStartRef.current = null;
  }, [zoom, hasNext, hasPrev, goNext, goPrev]);

  // ── Gallery auto-scroll ───────────────────────────────────────────────────
  const galleryRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!galleryRef.current || siblingIndex < 0) return;
    const el = galleryRef.current.children[siblingIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
  }, [siblingIndex]);

  const handleImageLoad = () => setState("ready");
  const handleError = () => setState("error");

  const rotateClockwise = () => setRotation((r: number) => (r + 90) % 360);
  const zoomIn = () => setZoom((z: number) => Math.min(z + 0.5, 5));
  const zoomOut = () => setZoom((z: number) => Math.max(1, z - 0.5));

  const mediaTransform = `scale(${zoom}) rotate(${rotation}deg)`;
  const hasSiblingGallery = !!(siblings && siblings.length > 1);

  return (
    <div
      className="fixed inset-0 z-50 bg-black flex flex-col"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* ── Top bar ── */}
      <div className="flex items-center gap-1 px-3 h-14 bg-black/70 backdrop-blur-sm shrink-0 z-10">
        <button id="viewer-close" onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors">
          <X size={18} />
        </button>
        <p className="text-sm text-white/80 font-medium truncate flex-1 px-1">{name}</p>

        {category === "image" && (
          <>
            <button
              id="viewer-zoom-out"
              onClick={zoomOut}
              disabled={zoom <= 1}
              className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors disabled:opacity-30"
              title="Zoom out"
            >
              <span className="text-xl font-light leading-none select-none">−</span>
            </button>
            <button
              id="viewer-zoom-in"
              onClick={zoomIn}
              disabled={zoom >= 5}
              className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors disabled:opacity-30"
              title="Zoom in"
            >
              <span className="text-xl font-light leading-none select-none">+</span>
            </button>
          </>
        )}

        {(category === "image" || category === "video") && (
          <button
            id="viewer-rotate"
            onClick={rotateClockwise}
            className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors"
            title="Rotate 90°"
          >
            <RotateCw size={16} />
          </button>
        )}

        <a
          id="viewer-download"
          href={`/api/files/serve?path=${encodeURIComponent(relativePath)}&download=1`}
          className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors"
          title="Download"
        >
          <Download size={18} />
        </a>
      </div>

      {/* ── Main media area ── */}
      <div className="flex-1 relative overflow-hidden flex items-center justify-center min-h-0">
        {/* Desktop prev/next arrows (hidden on mobile/tablet) */}
        {hasPrev && (
          <button
            id="viewer-prev"
            onClick={goPrev}
            className="hidden md:flex absolute left-3 z-10 p-2.5 rounded-full bg-black/50 hover:bg-black/80 text-white transition-colors items-center justify-center"
          >
            <ChevronLeft size={24} />
          </button>
        )}
        {hasNext && (
          <button
            id="viewer-next"
            onClick={goNext}
            className="hidden md:flex absolute right-3 z-10 p-2.5 rounded-full bg-black/50 hover:bg-black/80 text-white transition-colors items-center justify-center"
          >
            <ChevronRight size={24} />
          </button>
        )}

        {/* Image */}
        {category === "image" && (
          <div key={`img-${relativePath}`} className="w-full h-full flex items-center justify-center overflow-hidden select-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={name}
              onLoad={handleImageLoad}
              onError={handleError}
              draggable={false}
              style={{
                transform: mediaTransform,
                transformOrigin: "center",
                transition: "transform 0.2s ease",
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
              }}
            />
          </div>
        )}

        {/* Supported video */}
        {category === "video" && !isUnsupportedVideo && (
          <div key={`vid-${relativePath}`} className="w-full h-full flex items-center justify-center overflow-hidden">
            {needsTranscode === null ? (
              // Still probing codec — show a brief spinner
              <div className="flex flex-col items-center gap-3 text-white/50">
                <div className="w-8 h-8 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
                <p className="text-sm">Checking video compatibility…</p>
              </div>
            ) : (
              <video
                key={`vid-src-${needsTranscode}`}
                src={needsTranscode ? transcodeSrc : serveSrc}
                poster={cachePath ? `/api/cache/${cachePath}` : undefined}
                controls
                autoPlay
                onLoadedData={handleImageLoad}
                onError={handleError}
                style={{
                  transform: mediaTransform,
                  transformOrigin: "center",
                  transition: "transform 0.2s ease",
                  maxWidth: "100%",
                  maxHeight: "100%",
                }}
              />
            )}
          </div>
        )}

        {/* Unsupported video fallback */}
        {category === "video" && isUnsupportedVideo && (
          <div key={`vid-unsupported-${relativePath}`} className="flex flex-col items-center gap-4 text-white/60 px-6 text-center">
            {cachePath
              ? <img src={`/api/cache/${cachePath}`} alt={name} className="max-w-[300px] max-h-[300px] rounded-lg opacity-70 object-contain" />
              : <FileVideo2 size={80} strokeWidth={1} className="opacity-30" />
            }
            <p className="text-white/80 text-sm">This video format isn&apos;t supported in the browser.</p>
            <a
              href={`/api/files/serve?path=${encodeURIComponent(relativePath)}&download=1`}
              className="px-4 py-2 rounded-lg bg-[hsl(var(--primary))] text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Download to watch
            </a>
          </div>
        )}

        {/* PDF / text */}
        {(mimeType === "application/pdf" || mimeType?.startsWith("text/")) && (
          <iframe
            key={`iframe-${relativePath}`}
            src={serveSrc}
            className="w-full h-full border-0 bg-white"
            onLoad={handleImageLoad}
            title={name}
          />
        )}

        {/* Generic other */}
        {category === "other" && !(mimeType === "application/pdf" || mimeType?.startsWith("text/")) && (
          <div className="flex flex-col items-center gap-3 text-white/60">
            <p className="text-white/80 text-sm">Preview not available.</p>
            <a
              href={`/api/files/serve?path=${encodeURIComponent(relativePath)}&download=1`}
              className="px-4 py-2 rounded-lg bg-[hsl(var(--primary))] text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Download file
            </a>
          </div>
        )}

        {/* Error */}
        {state === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/60">
            <WifiOff size={40} strokeWidth={1} />
            <p className="text-white/80">Failed to load file.</p>
          </div>
        )}
      </div>

      {/* ── Bottom thumbnail gallery ── */}
      {hasSiblingGallery && (
        <div className="shrink-0 bg-black/80 backdrop-blur-sm border-t border-white/10 py-2 px-2">
          <div
            ref={galleryRef}
            className="flex gap-1.5 overflow-x-auto"
            style={{ scrollSnapType: "x mandatory", scrollbarWidth: "none" }}
          >
            {siblings!.map((s) => {
              const isActive = s.id === currentId;
              const thumbCat = getFileCategory(s.mimeType, s.name);
              return (
                <button
                  key={s.id}
                  onClick={() => onNavigateTo?.(s)}
                  style={{ scrollSnapAlign: "center" }}
                  className={[
                    "relative shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 transition-all duration-200",
                    isActive
                      ? "border-white scale-105 shadow-lg shadow-white/20"
                      : "border-transparent opacity-55 hover:opacity-85 hover:border-white/40",
                  ].join(" ")}
                  title={s.name}
                >
                  {s.cachePath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/cache/${s.cachePath}`}
                      alt={s.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-white/10">
                      {thumbCat === "video"
                        ? <FileVideo2 size={20} className="text-white/60" />
                        : <ImageIcon size={20} className="text-white/60" />
                      }
                    </div>
                  )}
                  {isActive && (
                    <div className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-white shadow-sm" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}



