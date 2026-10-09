/**
 * A fake backend so the app's screens run in a plain browser (previews and
 * screenshot tests). Pick a scenario with ?scenario=busy|empty|offline|signedout|diskfull.
 */

import type { AppSettings, Batch, Conflict, FolderListing, Item, Snapshot } from "./ipc";

const scenario = new URLSearchParams(location.search).get("scenario") ?? "busy";
const MB = 1024 * 1024;
const GB = 1024 * MB;
const now = Date.now();

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

let settings: AppSettings = {
  parallelFiles: 3,
  parallelChunks: 2,
  speedLimit: 0,
  useLan: true,
  keepAwake: true,
  startAtLogin: true,
  explorerMenu: true,
  sendTo: true,
  downloadDir: "C:\\Users\\Alex\\Downloads\\Loom",
  askDownloadDir: false,
  updateMode: "ask",
};

let serverChecks = 0;

const batches: Batch[] =
  scenario === "empty"
    ? []
    : [
        {
          id: 7, direction: "upload", title: "Trip to the hills", remoteDir: "Photos/2026", localDir: null, state: "active", paused: false,
          createdAt: now - 18 * 60_000, finishedAt: null, filesTotal: 1240, filesDone: 482, filesFailed: 0, filesConflict: 0, filesSkipped: 0,
          bytesTotal: 5.6 * GB, bytesDone: 2.15 * GB, bytesPerSecond: 11.8 * MB, scanning: false, lastError: null,
        },
        {
          id: 6, direction: "upload", title: "Family reunion.mov", remoteDir: "Videos", localDir: null, state: "active", paused: true,
          createdAt: now - 3 * 3600_000, finishedAt: null, filesTotal: 1, filesDone: 0, filesFailed: 0, filesConflict: 0, filesSkipped: 0,
          bytesTotal: 14.2 * GB, bytesDone: 9.1 * GB, bytesPerSecond: 0, scanning: false, lastError: null,
        },
        {
          id: 5, direction: "upload", title: "Scans", remoteDir: "Documents", localDir: null, state: "active", paused: false,
          createdAt: now - 25 * 60_000, finishedAt: null, filesTotal: 46, filesDone: 43, filesFailed: 0, filesConflict: 3, filesSkipped: 0,
          bytesTotal: 212 * MB, bytesDone: 198 * MB, bytesPerSecond: 0, scanning: false, lastError: null,
        },
        {
          id: 4, direction: "download", title: "Tax 2025", remoteDir: "Documents", localDir: "C:\\Users\\Alex\\Downloads\\Loom", state: "active", paused: false,
          createdAt: now - 4 * 60_000, finishedAt: null, filesTotal: 18, filesDone: 7, filesFailed: 0, filesConflict: 0, filesSkipped: 0,
          bytesTotal: 340 * MB, bytesDone: 121 * MB, bytesPerSecond: 6.2 * MB, scanning: false, lastError: null,
        },
        {
          id: 3, direction: "upload", title: "Phone backup", remoteDir: "Backups", localDir: null, state: "active", paused: false,
          createdAt: now - 2 * 3600_000, finishedAt: null, filesTotal: 310, filesDone: 308, filesFailed: 2, filesConflict: 0, filesSkipped: 0,
          bytesTotal: 2.1 * GB, bytesDone: 2.09 * GB, bytesPerSecond: 0, scanning: false, lastError: "The file was moved or deleted",
        },
        {
          id: 2, direction: "upload", title: "Wallpapers", remoteDir: "Photos", localDir: null, state: "done", paused: false,
          createdAt: now - 26 * 3600_000, finishedAt: now - 25 * 3600_000, filesTotal: 64, filesDone: 64, filesFailed: 0, filesConflict: 0, filesSkipped: 0,
          bytesTotal: 380 * MB, bytesDone: 380 * MB, bytesPerSecond: 0, scanning: false, lastError: null,
        },
        {
          id: 1, direction: "download", title: "Wedding album", remoteDir: "Photos", localDir: "C:\\Users\\Alex\\Downloads\\Loom", state: "done", paused: false,
          createdAt: now - 3 * 86_400_000, finishedAt: now - 3 * 86_400_000 + 600_000, filesTotal: 412, filesDone: 412, filesFailed: 0, filesConflict: 0, filesSkipped: 0,
          bytesTotal: 3.4 * GB, bytesDone: 3.4 * GB, bytesPerSecond: 0, scanning: false, lastError: null,
        },
      ];

function items(batchId: number): Item[] {
  const b = batches.find((x) => x.id === batchId);
  if (!b) return [];
  const names = ["IMG_4021.HEIC", "IMG_4022.HEIC", "IMG_4023.MOV", "IMG_4024.HEIC", "IMG_4025.HEIC", "IMG_4026.JPG", "IMG_4027.JPG", "DSC_0193.NEF"];
  return names.map((n, i) => ({
    id: batchId * 100 + i,
    batchId,
    localPath: `C:\\Users\\Alex\\Pictures\\${b.title}\\${n}`,
    remotePath: `${b.title}/${n}`,
    size: (i === 2 ? 820 : 4 + i) * MB,
    bytesDone: i < 2 ? (i === 0 ? 2.6 : 1.1) * MB : 0,
    state: b.state === "done" ? "done" : i < 2 ? "running" : i === 2 && b.filesFailed ? "failed" : "queued",
    error: i === 2 && b.filesFailed ? "The file was moved or deleted" : null,
    attempts: 0,
    resultPath: null,
    nextTryAt: 0,
  }));
}

const conflicts: Conflict[] = [
  { itemId: 501, relativePath: "Scans/Passport.pdf", incomingSize: 2.4 * MB, incomingModifiedMs: now - 86_400_000, existingSize: 2.4 * MB, existingModified: new Date(now - 86_400_000).toISOString(), existingIsFolder: false, same: true },
  { itemId: 502, relativePath: "Scans/Lease agreement.pdf", incomingSize: 5.1 * MB, incomingModifiedMs: now - 3600_000, existingSize: 4.8 * MB, existingModified: new Date(now - 40 * 86_400_000).toISOString(), existingIsFolder: false, same: false },
  { itemId: 503, relativePath: "Scans/Receipts", incomingSize: 0.2 * MB, incomingModifiedMs: now - 7200_000, existingSize: null, existingModified: new Date(now - 9 * 86_400_000).toISOString(), existingIsFolder: true, same: false },
];

function snapshot(): Snapshot {
  const open = batches.filter((b) => b.state !== "done");
  return {
    active: scenario === "offline" || scenario === "signedout" ? 0 : 4,
    queued: 760,
    paused: 1,
    waiting: scenario === "offline" ? 6 : 0,
    failed: 2,
    conflicts: 3,
    bytesDone: open.reduce((s, b) => s + b.bytesDone, 0),
    bytesTotal: open.reduce((s, b) => s + b.bytesTotal, 0),
    bytesPerSecond: scenario === "busy" ? 18 * MB : 0,
    via: scenario === "busy" ? "lan" : "internet",
    offline: scenario === "offline",
    signedOut: scenario === "signedout",
    diskFull: scenario === "diskfull",
    allPaused: false,
  };
}

const folders: Record<string, string[]> = {
  "": ["Backups", "Documents", "Music", "Photos", "Videos"],
  Photos: ["2024", "2025", "2026", "Wallpapers"],
  "Photos/2026": ["Trip to the hills", "Diwali"],
  Documents: ["Scans", "Tax 2025", "Work"],
};

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 40));
  const r = ((): unknown => {
    switch (cmd) {
      case "app_state":
        return {
          configured: scenario !== "onboarding",
          serverUrl: "https://loom.example.com",
          serverVersion: "2.2.0",
          user: { name: "Alex", email: "owner@example.com" },
          deviceName: "STUDY-PC",
          version: "1.0.0",
        };
      case "check_server":
        return String(args.url).includes("nope")
          ? { ok: false, url: args.url, version: null, error: "There's no Loom at that address." }
          : { ok: true, url: "https://loom.example.com", version: "2.2.0", error: null };
      case "start_pairing":
        setTimeout(() => emit("pairing", "approved"), 6000);
        return { checkCode: "482 913" };
      case "snapshot":
        return snapshot();
      case "batches":
        return args.includeFinished ? batches : batches.filter((b) => b.state !== "done");
      case "items":
        return items(Number(args.batchId));
      case "conflicts":
        return conflicts;
      case "settings":
        return settings;
      case "set_settings":
        settings = args.settings as AppSettings;
        return null;
      case "list_folder": {
        const path = String(args.path ?? "");
        return { path, folders: (folders[path] ?? []).map((n) => ({ name: n, path: path ? `${path}/${n}` : n })), canWrite: true } satisfies FolderListing;
      }
      case "pending_upload":
        return { names: ["Trip to the hills", "IMG_4180.HEIC", "IMG_4181.HEIC"], count: 3, destDir: null };
      case "recent_destinations":
        return ["Photos/2026", "Documents/Scans", "Videos"];
      case "choose_download_dir":
        return "D:\\Loom downloads";
      case "server_status":
        // The offline screen: Loom answers on the third check.
        return ++serverChecks >= 3;
      case "update_info":
      case "check_updates":
        return {
          current: "1.1.0",
          mode: settings.updateMode,
          status:
            scenario === "update"
              ? { state: "ready", version: "1.2.0", notes: "Faster folder uploads and a floating progress bar." }
              : { state: "upToDate", checkedAt: Math.floor(now / 1000) - 3600 },
        };
      default:
        return null;
    }
  })();
  return r as T;
}

function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((l) => l(payload));
}

export async function listen<T>(event: string, handler: (payload: T) => void) {
  const set = listeners.get(event) ?? new Set();
  set.add(handler as Listener);
  listeners.set(event, set);
  return () => set.delete(handler as Listener);
}
