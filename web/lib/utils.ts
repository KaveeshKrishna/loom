import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | bigint): string {
  const n = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (n === 0) return "0 B";
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
  mimeType: string | null
): "image" | "video" | "document" | "audio" | "other" {
  if (!mimeType) return "other";
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
  return "other";
}

export function getExtension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
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

/**
 * Serialize a FileNode (or array thereof) to be JSON-safe.
 * Converts BigInt size to a string so NextResponse.json() doesn't throw.
 */
export function serializeNode<T extends { size?: bigint | null }>(node: T): Omit<T, "size"> & { size: string | null } {
  return { ...node, size: node.size != null ? node.size.toString() : null };
}

export function serializeNodes<T extends { size?: bigint | null }>(nodes: T[]): (Omit<T, "size"> & { size: string | null })[] {
  return nodes.map(serializeNode);
}
