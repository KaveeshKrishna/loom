/** Shape of a file/folder as returned by the listing APIs (BigInts arrive as strings). */
export interface LNode {
  id: string;
  relativePath: string;
  parentPath?: string;
  name: string;
  type: "FILE" | "DIRECTORY";
  mimeType: string | null;
  size: string | number | null;
  modifiedAt: string | null;
  updatedAt?: string;
  indexedAt?: string;
  healthStatus?: "HEALTHY" | "CORRUPT" | "UNSUPPORTED";
  healthError?: string | null;
  browserCompatible?: boolean | null;
  inTrash?: boolean;
  contentIdentityId?: string | null;
  contentIdentity?: {
    id?: string;
    thumbnail?: { cachePath: string } | null;
    preview?: { cachePath: string; width?: number | null; height?: number | null } | null;
    mediaInfo?: Record<string, unknown> | null;
  } | null;
  /** Thumbnail/preview is being generated in the background */
  processing?: boolean;
}

export function thumbUrl(n: LNode): string | null {
  const c = n.contentIdentity?.thumbnail?.cachePath;
  return c ? `/api/cache/${c}` : null;
}

export function previewUrl(n: LNode): string | null {
  const c = n.contentIdentity?.preview?.cachePath ?? n.contentIdentity?.thumbnail?.cachePath;
  return c ? `/api/cache/${c}` : null;
}

export function serveUrl(relativePath: string, download = false): string {
  return `/api/files/serve?path=${encodeURIComponent(relativePath)}${download ? "&download=1" : ""}`;
}
