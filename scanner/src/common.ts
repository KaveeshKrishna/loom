/**
 * Shared scanner state: database client, paths, logging, and change events.
 */
import { PrismaClient } from "@prisma/client";
import { join } from "path";

export const prisma = new PrismaClient();

export const MEDIA_ROOT = process.env.MEDIA_ROOT ?? "/media";
export const CACHE_ROOT = process.env.CACHE_ROOT ?? "/cache";
export const THUMB_DIR = join(CACHE_ROOT, "thumbnails");
export const PREVIEW_DIR = join(CACHE_ROOT, "previews");
export const VIDEO_CACHE_DIR = join(CACHE_ROOT, "videos");
export const TEMP_DIR = join(CACHE_ROOT, "temp");
export const TRASH_DIR = join(MEDIA_ROOT, ".LoomTrash");
export const UPLOAD_TEMP_DIR = join(MEDIA_ROOT, ".tmp-upload");

/** Bump when thumbnail/preview generation settings change (v2: EXIF auto-rotation). */
export const THUMB_PROFILE = "v2";
export const PREVIEW_PROFILE = "v2";
/** Must match HLS_PROFILE in web/lib/hls-manager.ts. */
export const HLS_PROFILE = "v2";

/** Folders the scanner never enters: OS metadata and Loom's own internals. */
export const IGNORED_NAMES = new Set([
  "$RECYCLE.BIN",
  "System Volume Information",
  ".Trashes",
  ".Spotlight-V100",
  ".fseventsd",
  ".TemporaryItems",
  ".DS_Store",
  "RECYCLER",
  "FOUND.000",
  ".tmp-upload",
  ".LoomTrash",
  "@eaDir",
  "lost+found",
]);

export function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.startsWith("._") || isLoomTempName(name);
}

/** Temporary files Loom writes while copying, editing or renaming (see web/lib/fs-journal.ts). */
export function isLoomTempName(name: string): boolean {
  return name.startsWith(".loom-tmp-") || name.startsWith(".loom-rename-") || name.startsWith(".loom-edit-");
}

/** Journal of in-flight operations, written by the web app (web/lib/fs-journal.ts). */
export const JOURNAL_DIR = join(UPLOAD_TEMP_DIR, "journal");

export const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".avif", ".tif", ".tiff", ".bmp", ".thm", ".thim",
]);
export const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".mpg", ".mpeg", ".3gp", ".wmv", ".flv", ".mts", ".m2ts", ".ts",
]);

export function log(level: "INFO" | "WARN" | "ERROR", msg: string, data?: unknown) {
  const entry = `[${new Date().toISOString()}] [${level}] ${msg}`;
  if (data !== undefined) console.log(entry, JSON.stringify(data));
  else console.log(entry);
}

export function sourceVersionOf(size: number, mtimeMs: number): string {
  return `${size}-${mtimeMs}`;
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

/** Tell open browser tabs which folders changed (best effort). */
export async function publishChange(dirs: string[], nodeIds?: string[], reason?: string): Promise<void> {
  const payload = JSON.stringify({ type: "changed", dirs: [...new Set(dirs)].slice(0, 50), nodeIds: nodeIds?.slice(0, 50), reason });
  await prisma.$executeRaw`SELECT pg_notify('loom_events', ${payload})`.catch(() => {});
}

export async function setStatus(key: string, value: string) {
  await prisma.systemStatus
    .upsert({ where: { key }, update: { value }, create: { key, value } })
    .catch(() => {});
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}
