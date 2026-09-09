/**
 * Shared shape definitions for the demo world. These mirror the JSON shape
 * the real API routes produce (BigInt sizes as strings, Dates as ISO
 * strings) — see the fetch-inventory notes in web/lib/demo/mockServer.ts
 * for exactly which route each shape corresponds to.
 */

export type DemoNodeType = "FILE" | "DIRECTORY";
export type DemoHealthStatus = "HEALTHY" | "UNSUPPORTED" | "CORRUPT";
export type DemoRole = "OWNER" | "FAMILY";

export interface DemoThumbnail {
  id: string;
  cachePath: string;
  width: number;
  height: number;
}

export interface DemoPreview {
  id: string;
  cachePath: string;
  width: number | null;
  height: number | null;
}

export interface DemoVideoCache {
  id: string;
  durationSeconds: number | null;
}

export interface DemoContentIdentity {
  id: string;
  size: string;
  fastHash: string;
  thumbnail: DemoThumbnail | null;
  preview: DemoPreview | null;
  videoCaches: DemoVideoCache[];
}

export interface DemoFileNode {
  id: string;
  relativePath: string;
  name: string;
  type: DemoNodeType;
  mimeType: string | null;
  size: string | null;
  modifiedAt: string | null;
  updatedAt: string;
  indexedAt: string;
  isVisible: boolean;
  sourceVersion: string | null;
  browserCompatible: boolean | null;
  healthStatus: DemoHealthStatus;
  healthError: string | null;
  inTrash: boolean;
  contentIdentityId: string | null;
  contentIdentity: DemoContentIdentity | null;
}

export interface DemoUser {
  id: string;
  name: string;
  email: string;
  role: DemoRole;
  createdAt: string;
}

export interface DemoAclRule {
  id: string;
  userId: string;
  path: string;
  allow: boolean;
}

export interface DemoAuditLog {
  id: string;
  userId: string | null;
  action: string;
  details: Record<string, unknown> | null;
  timestamp: string;
}

export interface DemoTrashItem {
  id: string;
  fileNodeId: string;
  originalPath: string;
  trashPath: string;
  deletedAt: string;
  expiresAt: string;
  deletedByUserId: string;
}

export interface DemoNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface DemoScanJob {
  id: string;
  type: "FULL_RESCAN" | "INDEX_FILE";
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  processedFiles?: number;
  totalFiles?: number;
}

export interface DemoFavorite {
  userId: string;
  fileNodeId: string;
  createdAt: string;
}

export interface DemoWorld {
  version: number;
  nodes: DemoFileNode[];
  users: DemoUser[];
  aclRules: DemoAclRule[];
  auditLogs: DemoAuditLog[];
  trashItems: DemoTrashItem[];
  notifications: DemoNotification[];
  favorites: DemoFavorite[];
  scanJobs: DemoScanJob[];
  scannerStatus: string;
  videoCacheStats: { usedBytes: number; limitBytes: number; cachedVideos: number };
  thumbCacheStats: { thumbCount: number; previewCount: number; physicalFiles: number };
}

/** The id used for the always-logged-in demo Owner account. */
export const DEMO_OWNER_ID = "demo-owner";
export const DEMO_OWNER_EMAIL = "demo@example.com";
