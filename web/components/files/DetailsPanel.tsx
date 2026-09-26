"use client";

/**
 * Drive-style details side panel: preview, size, dates, location, media
 * metadata (EXIF camera/date/GPS, video duration/codec/resolution), health
 * and recent activity for the selected item.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { X, MapPin, Camera, Calendar, HardDrive, FolderOpen, Film, AlertTriangle, Clock, Star } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { api, filesHref, parentOf } from "@/lib/client/api";
import type { LNode } from "@/lib/client/types";
import { previewUrl } from "@/lib/client/types";
import { FileIcon } from "./FileIcon";

interface Props {
  node: LNode | null;
  selectionCount: number;
  onClose: () => void;
}

interface Details {
  size: string;
  fileCount?: number;
  dirCount?: number;
  modifiedAt: string | null;
  indexedAt: string;
  mimeType: string | null;
  healthStatus: string;
  healthError: string | null;
  mediaInfo: Record<string, unknown> | null;
  browserCompatible: boolean | null;
  favorite: boolean;
  activity: { action: string; timestamp: string; userName: string | null }[];
}

const ACTION_LABEL: Record<string, string> = {
  UPLOAD: "Uploaded",
  RENAME: "Renamed",
  MOVE: "Moved",
  COPY: "Copied",
  TRASH: "Moved to Trash",
  RESTORE: "Restored",
  MKDIR: "Created",
  EDIT: "Edited",
  CREATE_FILE: "Created",
  SHARE_CREATED: "Shared",
};

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-2">
      <span className="text-[hsl(var(--muted-foreground))] mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{label}</p>
        <div className="text-sm break-words">{children}</div>
      </div>
    </div>
  );
}

function fmtDuration(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function DetailsPanel({ node, selectionCount, onClose }: Props) {
  const [d, setD] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setD(null);
    setError(null);
    if (!node) return;
    const ctrl = new AbortController();
    api<Details>(`/api/files/properties?path=${encodeURIComponent(node.relativePath)}`, { signal: ctrl.signal })
      .then(setD)
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError((e as Error).message);
      });
    return () => ctrl.abort();
  }, [node]);

  const info = (d?.mediaInfo ?? {}) as Record<string, unknown>;
  const gps = info.gps as { lat: number; lon: number } | undefined;
  const img = node ? previewUrl(node) : null;

  return (
    <aside className="w-full h-full flex flex-col bg-[hsl(var(--card))] border-l" aria-label="Details">
      <div className="flex items-center justify-between px-4 h-12 border-b shrink-0">
        <p className="text-sm font-semibold truncate">{node ? node.name : selectionCount > 1 ? `${selectionCount} items selected` : "Details"}</p>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-[hsl(var(--accent))] text-[hsl(var(--muted-foreground))]" aria-label="Close details">
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {!node ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))] py-8 text-center">
            {selectionCount > 1 ? "Select a single item to see its details." : "Select a file or folder to see its details."}
          </p>
        ) : (
          <>
            <div className="aspect-video rounded-lg bg-[hsl(var(--accent))] flex items-center justify-center overflow-hidden mb-3">
              {img ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img} alt="" className="w-full h-full object-contain" />
              ) : (
                <FileIcon mimeType={node.mimeType} type={node.type} size={48} name={node.name} />
              )}
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            {!d && !error && <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>}
            {d && (
              <div className="divide-y">
                <Row icon={<HardDrive size={15} />} label={node.type === "DIRECTORY" ? "Contents" : "Size"}>
                  {formatBytes(d.size)}
                  {node.type === "DIRECTORY" && (
                    <span className="text-[hsl(var(--muted-foreground))]">
                      {" "}
                      · {d.fileCount ?? 0} files, {d.dirCount ?? 0} folders
                    </span>
                  )}
                </Row>
                <Row icon={<FolderOpen size={15} />} label="Location">
                  <Link href={filesHref(parentOf(node.relativePath))} className="text-[hsl(var(--primary))] hover:underline">
                    {parentOf(node.relativePath) || "Home"}
                  </Link>
                </Row>
                {d.modifiedAt && (
                  <Row icon={<Clock size={15} />} label="Modified">
                    {new Date(d.modifiedAt).toLocaleString()}
                  </Row>
                )}
                {typeof info.takenAt === "string" && (
                  <Row icon={<Calendar size={15} />} label={info.kind === "video" ? "Recorded" : "Taken"}>
                    {new Date(info.takenAt).toLocaleString()}
                  </Row>
                )}
                {(info.width as number) > 0 && (
                  <Row icon={info.kind === "video" ? <Film size={15} /> : <Camera size={15} />} label={info.kind === "video" ? "Video" : "Image"}>
                    {String(info.width)} × {String(info.height)}
                    {typeof info.durationSeconds === "number" && ` · ${fmtDuration(info.durationSeconds)}`}
                    {typeof info.videoCodec === "string" && (
                      <span className="text-[hsl(var(--muted-foreground))]">
                        {" "}
                        · {info.videoCodec.toUpperCase()}
                        {typeof info.audioCodec === "string" && ` / ${info.audioCodec.toUpperCase()}`}
                      </span>
                    )}
                    {info.kind === "video" && d.browserCompatible === false && (
                      <p className="text-xs text-[hsl(var(--muted-foreground))]">Converted on the fly for playback</p>
                    )}
                  </Row>
                )}
                {typeof info.camera === "string" && (
                  <Row icon={<Camera size={15} />} label="Camera">
                    {info.camera}
                    {typeof info.lens === "string" && <p className="text-xs text-[hsl(var(--muted-foreground))]">{info.lens}</p>}
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">
                      {[
                        typeof info.fNumber === "number" && `ƒ/${info.fNumber}`,
                        typeof info.exposureTime === "number" && (info.exposureTime < 1 ? `1/${Math.round(1 / info.exposureTime)}s` : `${info.exposureTime}s`),
                        typeof info.iso === "number" && `ISO ${info.iso}`,
                        typeof info.focalLength === "number" && `${info.focalLength}mm`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </Row>
                )}
                {gps && (
                  <Row icon={<MapPin size={15} />} label="Location taken">
                    <a
                      href={`https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lon}#map=15/${gps.lat}/${gps.lon}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[hsl(var(--primary))] hover:underline"
                    >
                      {gps.lat.toFixed(4)}, {gps.lon.toFixed(4)}
                    </a>
                  </Row>
                )}
                {d.favorite && (
                  <Row icon={<Star size={15} />} label="Starred">
                    Yes
                  </Row>
                )}
                {d.healthStatus !== "HEALTHY" && (
                  <Row icon={<AlertTriangle size={15} className="text-amber-500" />} label={d.healthStatus === "CORRUPT" ? "Looks damaged" : "Preview not supported"}>
                    <span className="text-xs text-[hsl(var(--muted-foreground))]">{d.healthError}</span>
                  </Row>
                )}
                {d.activity.length > 0 && (
                  <div className="py-2">
                    <p className="text-[11px] uppercase tracking-wide text-[hsl(var(--muted-foreground))] mb-1">Activity</p>
                    <ul className="space-y-1">
                      {d.activity.map((a, i) => (
                        <li key={i} className="text-xs">
                          <span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span>
                          {a.userName && <span className="text-[hsl(var(--muted-foreground))]"> by {a.userName}</span>}
                          <span className="text-[hsl(var(--muted-foreground))]"> · {new Date(a.timestamp).toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
