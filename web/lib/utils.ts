import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | bigint | string): string {
  const n = typeof bytes === "number" ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return `${parseFloat((n / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDate(date: Date | string | null): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}

export function getFileCategory(
  mimeType: string | null,
  filename?: string
): "image" | "video" | "document" | "audio" | "other" {
  if (mimeType) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    if (
      mimeType.includes("pdf") ||
      mimeType.includes("document") ||
      mimeType.includes("text") ||
      mimeType.includes("presentation") ||
      mimeType.includes("spreadsheet")
    )
      return "document";
  }

  if (filename) {
    const ext = getExtension(filename);
    if (["thm", "thim", "heic", "heif", "avif", "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff"].includes(ext)) return "image";
    if (["mpg", "mpeg", "mkv", "avi", "wmv", "flv", "mp4", "m4v", "webm", "mov", "3gp", "mts", "m2ts"].includes(ext)) return "video";
    if (["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "wma", "aiff"].includes(ext)) return "audio";
    if (["pdf", "txt", "md", "doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "epub"].includes(ext)) return "document";
  }

  return "other";
}

export function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

export function truncateName(name: string, maxLen: number = 15): string {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 3) + "...";
}

/**
 * Sanitize a path segment to prevent traversal attacks.
 */
export function sanitizePath(raw: string): string {
  return raw
    .split("/")
    .filter((segment) => segment && segment !== ".." && segment !== ".")
    .join("/");
}

/**
 * Deep-serialize a value to be JSON-safe.
 * Converts ALL BigInt fields (at any nesting depth) to strings.
 * This handles FileNode.size, ContentIdentity.size, VideoCache.sizeBytes, etc.
 */
function deepSerializeBigInt<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, val) =>
      typeof val === "bigint" ? val.toString() : val
    )
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeNode<T>(node: T): any {
  return deepSerializeBigInt(node);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeNodes<T>(nodes: T[]): any[] {
  return deepSerializeBigInt(nodes);
}

const collator = typeof Intl !== "undefined" ? new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }) : null;

/** Natural-order name comparison: "IMG_2" sorts before "IMG_10". */
export function compareNames(a: string, b: string): number {
  return collator ? collator.compare(a, b) : a.localeCompare(b);
}

type Sortable = { type: string; name: string; size?: string | number | bigint | null; modifiedAt?: string | Date | null; mimeType?: string | null };

/** Folders first, then by the chosen key (name by default). */
export function sortNodes<T extends Sortable>(nodes: T[], key: "name" | "modified" | "size" | "type" = "name", dir: "asc" | "desc" = "asc"): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const time = (v: T["modifiedAt"]) => (v ? new Date(v).getTime() : 0);
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "DIRECTORY" ? -1 : 1;
    let c = 0;
    if (key === "modified") c = time(a.modifiedAt) - time(b.modifiedAt);
    else if (key === "size") c = Number(a.size ?? 0) - Number(b.size ?? 0);
    else if (key === "type") c = compareNames(getExtension(a.name), getExtension(b.name));
    return (c || compareNames(a.name, b.name)) * (c ? sign : key === "name" ? sign : 1);
  });
}

export function matchesTypeFilter(n: { type: string; mimeType: string | null; name: string }, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "folders") return n.type === "DIRECTORY";
  if (n.type === "DIRECTORY") return false;
  const cat = getFileCategory(n.mimeType, n.name);
  return filter === "other" ? cat === "other" : cat === filter;
}
