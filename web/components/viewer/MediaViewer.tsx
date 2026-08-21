"use client";

import { useEffect, useCallback, useState } from "react";
import { X, Download, ZoomIn, ZoomOut, RotateCcw, ChevronLeft, ChevronRight, WifiOff } from "lucide-react";
import { getFileCategory } from "@/lib/utils";

interface MediaViewerProps {
  relativePath: string;
  name: string;
  mimeType: string | null;
  cachePath?: string | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

type ViewerState = "loading" | "ready" | "offline" | "error";

export function MediaViewer({
  relativePath, name, mimeType, cachePath, onClose, onPrev, onNext, hasPrev, hasNext,
}: MediaViewerProps) {
  const [state, setState] = useState<ViewerState>("loading");
  const [zoom, setZoom] = useState(1);
  const category = getFileCategory(mimeType);
  const serveSrc = `/api/files/serve?path=${encodeURIComponent(relativePath)}`;
  const src = (category === "image" || category === "video") && cachePath 
    ? `/api/cache/${cachePath}` 
    : serveSrc;

  useEffect(() => {
    setState("loading");
    setZoom(1);
  }, [relativePath]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && onPrev && hasPrev) onPrev();
      if (e.key === "ArrowRight" && onNext && hasNext) onNext();
    },
    [onClose, onPrev, onNext, hasPrev, hasNext]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleImageLoad = () => setState("ready");
  const handleError = () => setState("error");

  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col animate-in-fade"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-14 bg-black/50 shrink-0">
        <button id="viewer-close" onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors">
          <X size={18} />
        </button>
        <p className="text-sm text-white/80 font-medium truncate flex-1">{name}</p>
        <a
          id="viewer-download"
          href={`/api/files/serve?path=${encodeURIComponent(relativePath)}&download=1`}
          className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors"
        >
          <Download size={18} />
        </a>
        {category === "image" && state === "ready" && (
          <>
            <button id="viewer-zoom-in" onClick={() => setZoom((z) => Math.min(z + 0.25, 4))} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors"><ZoomIn size={18} /></button>
            <button id="viewer-zoom-out" onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors"><ZoomOut size={18} /></button>
            <button id="viewer-zoom-reset" onClick={() => setZoom(1)} className="p-2 rounded-lg hover:bg-white/10 text-white/80 hover:text-white transition-colors"><RotateCcw size={16} /></button>
          </>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center relative min-h-0 overflow-hidden p-4">
        {/* Prev/Next */}
        {hasPrev && (
          <button id="viewer-prev" onClick={onPrev} className="absolute left-3 z-10 p-2 rounded-full bg-black/40 hover:bg-black/70 text-white transition-colors">
            <ChevronLeft size={22} />
          </button>
        )}
        {hasNext && (
          <button id="viewer-next" onClick={onNext} className="absolute right-3 z-10 p-2 rounded-full bg-black/40 hover:bg-black/70 text-white transition-colors">
            <ChevronRight size={22} />
          </button>
        )}

        {/* Offline state */}
        {false && (
          <div className="flex flex-col items-center gap-3 text-white/60">
            <WifiOff size={48} strokeWidth={1} />
            <p className="text-lg font-medium text-white/80">Archive is currently offline</p>
            <p className="text-sm">The Samsung T7 is not connected. Thumbnails are still available.</p>
          </div>
        )}

        {/* Image viewer */}
        {category === "image" && true && (
          <div className="max-w-full max-h-full overflow-auto flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={name}
              onLoad={handleImageLoad}
              onError={handleError}
              style={{ transform: `scale(${zoom})`, transformOrigin: "center", transition: "transform 0.2s" }}
              className="max-w-full max-h-[75vh] object-contain rounded select-none"
            />
          </div>
        )}

        {/* Video viewer */}
        {category === "video" && true && (
          <video
            src={serveSrc}
            poster={cachePath ? `/api/cache/${cachePath}` : undefined}
            controls
            autoPlay
            onLoadedData={handleImageLoad}
            onError={handleError}
            className="max-w-full max-h-[75vh] rounded"
          />
        )}

        {/* PDF viewer */}
        {mimeType === "application/pdf" && true && (
          <iframe
            src={src}
            className="w-full h-[75vh] rounded border border-white/10"
            onLoad={handleImageLoad}
            title={name}
          />
        )}

        {/* Generic file */}
        {category === "other" && true && (
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
          <div className="flex flex-col items-center gap-2 text-white/60">
            <p className="text-white/80">Failed to load file.</p>
          </div>
        )}
      </div>
    </div>
  );
}
