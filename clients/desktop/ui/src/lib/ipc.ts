/**
 * Talking to the app (Rust side, src-tauri/src/commands.rs). In a plain
 * browser (VITE_MOCK=1) a fake backend answers instead, for previews and
 * screenshot tests.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

export type Direction = "upload" | "download";
export type ItemState = "checking" | "queued" | "running" | "waiting" | "conflict" | "done" | "skipped" | "failed" | "cancelled";
export type OnConflict = "ask" | "keep_both" | "replace" | "skip";

export interface Snapshot {
  active: number;
  queued: number;
  paused: number;
  waiting: number;
  failed: number;
  conflicts: number;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSecond: number;
  via: "lan" | "internet" | null;
  offline: boolean;
  signedOut: boolean;
  diskFull: boolean;
  allPaused: boolean;
}

export interface Batch {
  id: number;
  direction: Direction;
  title: string;
  remoteDir: string;
  localDir: string | null;
  state: string;
  paused: boolean;
  createdAt: number;
  finishedAt: number | null;
  filesTotal: number;
  filesDone: number;
  filesFailed: number;
  filesConflict: number;
  filesSkipped: number;
  bytesTotal: number;
  bytesDone: number;
  bytesPerSecond: number;
  scanning: boolean;
  lastError: string | null;
}

export interface Item {
  id: number;
  batchId: number;
  localPath: string;
  remotePath: string;
  size: number;
  bytesDone: number;
  state: ItemState;
  error: string | null;
  attempts: number;
  resultPath: string | null;
  nextTryAt: number;
}

export interface Conflict {
  itemId: number;
  relativePath: string;
  incomingSize: number;
  incomingModifiedMs: number;
  existingSize: number | null;
  existingModified: string | null;
  existingIsFolder: boolean;
  same: boolean;
}

export interface AppState {
  configured: boolean;
  serverUrl: string | null;
  serverVersion: string | null;
  user: { name: string; email: string } | null;
  deviceName: string;
  version: string;
}

export interface AppSettings {
  parallelFiles: number;
  parallelChunks: number;
  speedLimit: number;
  useLan: boolean;
  keepAwake: boolean;
  startAtLogin: boolean;
  explorerMenu: boolean;
  sendTo: boolean;
  downloadDir: string;
  askDownloadDir: boolean;
}

export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderListing {
  path: string;
  folders: FolderEntry[];
  canWrite: boolean;
}

export interface PendingUpload {
  names: string[];
  count: number;
  destDir: string | null;
}

export interface ServerCheck {
  ok: boolean;
  url: string;
  version: string | null;
  error: string | null;
}

export interface Pairing {
  checkCode: string;
}

export type EngineEvent =
  | { type: "batchFinished"; batchId: number; title: string; direction: Direction; done: number; failed: number; skipped: number }
  | { type: "conflictsFound"; batchId: number; count: number }
  | { type: "signedOut" }
  | { type: "diskFull" }
  | { type: "scanFinished"; batchId: number; files: number };

const MOCK = import.meta.env.VITE_MOCK === "1" || !("__TAURI_INTERNALS__" in window);

let mock: typeof import("./mock") | null = null;
async function mockModule() {
  mock ??= await import("./mock");
  return mock;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (MOCK) return (await mockModule()).invoke<T>(cmd, args);
  return tauriInvoke<T>(cmd, args);
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (MOCK) return (await mockModule()).listen<T>(event, handler);
  return tauriListen<T>(event, (e) => handler(e.payload));
}

export const isMock = MOCK;

/** Commands, typed. */
export const api = {
  appState: () => invoke<AppState>("app_state"),
  checkServer: (url: string) => invoke<ServerCheck>("check_server", { url }),
  startPairing: (url: string, deviceName: string) => invoke<Pairing>("start_pairing", { url, deviceName }),
  cancelPairing: () => invoke<void>("cancel_pairing"),
  signOut: () => invoke<void>("sign_out"),
  snapshot: () => invoke<Snapshot>("snapshot"),
  batches: (includeFinished: boolean) => invoke<Batch[]>("batches", { includeFinished }),
  items: (batchId: number, offset: number, limit: number) => invoke<Item[]>("items", { batchId, offset, limit }),
  conflicts: (batchId: number) => invoke<Conflict[]>("conflicts", { batchId }),
  decide: (batchId: number, itemId: number | null, decision: OnConflict) => invoke<number>("decide", { batchId, itemId, decision }),
  pause: (batchId: number | null) => invoke<void>("pause", { batchId }),
  resume: (batchId: number | null) => invoke<void>("resume", { batchId }),
  cancel: (batchId: number, itemId: number | null) => invoke<void>("cancel", { batchId, itemId }),
  retry: (batchId: number | null, itemId: number | null) => invoke<number>("retry", { batchId, itemId }),
  removeBatch: (batchId: number) => invoke<void>("remove_batch", { batchId }),
  clearFinished: () => invoke<number>("clear_finished"),
  pickUpload: (kind: "files" | "folder") => invoke<void>("pick_upload", { kind }),
  listFolder: (path: string) => invoke<FolderListing>("list_folder", { path }),
  createFolder: (parent: string, name: string) => invoke<string>("create_folder", { parent, name }),
  pendingUpload: () => invoke<PendingUpload | null>("pending_upload"),
  confirmUpload: (destDir: string, onConflict: OnConflict) => invoke<void>("confirm_upload", { destDir, onConflict }),
  cancelPendingUpload: () => invoke<void>("cancel_pending_upload"),
  recentDestinations: () => invoke<string[]>("recent_destinations"),
  settings: () => invoke<AppSettings>("settings"),
  setSettings: (settings: AppSettings) => invoke<void>("set_settings", { settings }),
  chooseDownloadDir: () => invoke<string | null>("choose_download_dir"),
  openMain: (path: string | null) => invoke<void>("open_main", { path }),
  openTransfers: () => invoke<void>("open_transfers"),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  openLogs: () => invoke<void>("open_logs"),
  closeWindow: () => invoke<void>("close_window"),
};
