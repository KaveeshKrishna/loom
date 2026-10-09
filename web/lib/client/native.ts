/**
 * native.ts — when this web UI runs inside a Loom app.
 *
 * The Windows and Android apps show Loom in an embedded browser and inject
 * `window.LoomApp` before the page loads. When it's there, uploads and
 * downloads go to the app's own transfer manager, which keeps going in the
 * background, survives restarts and resumes by itself, instead of this tab.
 * In a normal browser none of this exists and nothing changes.
 *
 * The app → page direction uses DOM events:
 *   "loomapp:transfers"  detail: NativeTransfers   (a few times a second while busy)
 *   "loomapp:navigate"   detail: { path }          (open a folder, e.g. after "Show in Loom")
 *   "loomapp:toast"      detail: { kind, message, action? }  (e.g. "Uploading 3 items to Photos")
 * The page calls LoomApp.ready() once it listens; apps hold events until then.
 *
 * From apiVersion 2, requests return a promise that resolves once the app
 * has the request. When it doesn't answer quickly, the page does the job
 * itself (its own file picker, a browser ZIP download) rather than leaving
 * the user with a click that did nothing.
 *
 * The bridge never hands the page local file paths, and the page can't ask
 * the app to read a path: it can only pass files the user picked or dropped
 * here, or ask the app to show its own picker.
 */

import { useEffect, useState } from "react";
import { toast } from "@/components/ui/Toaster";

export type NativeCapability =
  | "uploads.files" // uploadFiles(): files picked in the page
  | "uploads.dropped" // uploadDropped(): what was dropped on the page, folders included (the app walks them)
  | "uploads.picker" // pickUpload(): the app's own file/folder picker
  | "downloads" // download(): the app's download manager
  | "downloads.zip" // download({ zip: true }): the app makes the ZIP download too (a WebView can't do the page's form-post one)
  | "transfers" // openTransfers() + "loomapp:transfers" events
  | "settings"; // openSettings(): the app's own settings

export interface NativeUploadItem {
  /** Path inside the destination folder (folder uploads include sub-folders) */
  relativePath: string;
  size: number;
  lastModified: number;
  /** Decided beforehand in the page's conflict dialog */
  conflict: "replace" | "keep_both";
}

/** apiVersion 1 returns nothing; 2 returns a promise settled by the app's answer. */
type BridgeResult = void | Promise<unknown>;

export interface LoomAppBridge {
  apiVersion: number;
  platform: string;
  appVersion: string;
  capabilities: NativeCapability[];
  uploadFiles?(destDir: string, items: NativeUploadItem[], files: File[]): BridgeResult;
  uploadDropped?(destDir: string, items: { name: string; kind: "file" | "folder" }[], files: File[]): BridgeResult;
  pickUpload?(destDir: string, mode: "files" | "folder"): BridgeResult;
  download?(request: { items: NativeDownloadItem[]; zip?: boolean }): BridgeResult;
  openTransfers?(): BridgeResult;
  openSettings?(): BridgeResult;
  /** The folder on screen (null when not in a folder), for "upload here" from the app */
  setLocation?(location: { path: string | null; canWrite: boolean }): void;
  /** The user signed out in the page: the app should unpair */
  signedOut?(): void;
  /** The page is listening for "loomapp:*" events (sent after every page load) */
  ready?(): void;
  /** A line for the app's log */
  log?(level: "info" | "warn" | "error", message: string): void;
}

export interface NativeDownloadItem {
  path: string;
  name: string;
  type: "FILE" | "DIRECTORY";
}

export interface NativeTransfers {
  active: number;
  queued: number;
  paused: number;
  failed: number;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSecond: number;
  /** "lan" when going straight over the local network */
  via: "lan" | "internet" | null;
}

declare global {
  interface Window {
    LoomApp?: LoomAppBridge;
  }
}

/** The app bridge, or null in a normal browser. */
export function nativeApp(): LoomAppBridge | null {
  if (typeof window === "undefined") return null;
  const app = window.LoomApp;
  return app && typeof app === "object" && app.apiVersion >= 1 ? app : null;
}

export function hasNative(capability: NativeCapability): boolean {
  return !!nativeApp()?.capabilities?.includes(capability);
}

/** How long an app has to say it got a request before the page takes over. */
const ANSWER_MS = 2500;

const appName = () => (nativeApp()?.platform === "windows" ? "Loom for Windows" : "The Loom app");

/**
 * Did the app take the request? Version 1 apps don't answer (assume yes);
 * version 2 answers within ANSWER_MS, or we say so in its log and return false.
 */
async function answered(name: string, result: BridgeResult): Promise<boolean> {
  if (!result || typeof (result as Promise<unknown>).then !== "function") return true;
  const outcome = await Promise.race([
    (result as Promise<unknown>).then(
      () => "ok",
      (e: unknown) => `refused: ${(e as Error)?.message ?? e}`
    ),
    new Promise<string>((r) => setTimeout(() => r("no answer"), ANSWER_MS)),
  ]);
  if (outcome === "ok") return true;
  try {
    nativeApp()?.log?.("warn", `${name}: ${outcome}`);
  } catch {
    /* the bridge itself is broken */
  }
  return false;
}

/** Call the app; false if the call itself failed (a broken bridge). */
function call<T>(fn: () => T): T | false {
  try {
    return fn();
  } catch (e) {
    console.error("Loom app bridge:", e);
    return false;
  }
}

/** Hand files to the app (in batches, keeping each message small). False: upload them in the page. */
export async function nativeUploadFiles(destDir: string, items: NativeUploadItem[], files: File[]): Promise<boolean> {
  const app = nativeApp();
  if (!app?.uploadFiles) return false;
  for (let i = 0; i < items.length; i += 500) {
    const r = call(() => app.uploadFiles!(destDir, items.slice(i, i + 500), files.slice(i, i + 500)));
    if (r === false || !(await answered("uploadFiles", r))) {
      // Only the first batch can fall back cleanly; later ones are already the app's.
      if (i === 0) return false;
      toast.error(`${appName()} didn't take all the files. Upload the rest again.`);
      return true;
    }
  }
  return true;
}

/**
 * Hand what was dropped (files and whole folders, as the browser's File
 * objects) to the app, which reads them from disk itself. False: the page
 * should upload them.
 */
export async function nativeUploadDropped(destDir: string, items: { name: string; kind: "file" | "folder" }[], files: File[]): Promise<boolean> {
  const app = nativeApp();
  if (!app?.uploadDropped || !hasNative("uploads.dropped")) return false;
  const r = call(() => app.uploadDropped!(destDir, items, files));
  return r !== false && (await answered("uploadDropped", r));
}

/**
 * Upload files or a folder: the app's own picker inside an app, `fallback`
 * (the page's file input) in a browser or when the app doesn't answer.
 */
export function pickForUpload(destDir: string, mode: "files" | "folder", fallback: () => void) {
  const app = nativeApp();
  if (!app?.pickUpload || !hasNative("uploads.picker")) return fallback();
  const r = call(() => app.pickUpload!(destDir, mode));
  if (r === false) return fallback();
  void answered("pickUpload", r).then((ok) => {
    if (!ok) fallback();
  });
}

/**
 * Download through the app (resumable, folders kept as folders). Returns
 * false when the browser should do it; `fallback` runs if the app was asked
 * but didn't answer.
 */
export function nativeDownload(items: NativeDownloadItem[], fallback?: () => void, opts: { zip?: boolean } = {}): boolean {
  const app = nativeApp();
  if (!app?.download || !hasNative(opts.zip ? "downloads.zip" : "downloads") || items.length === 0) return false;
  const r = call(() => app.download!(opts.zip ? { items, zip: true } : { items }));
  if (r === false) return false;
  void answered("download", r).then((ok) => {
    if (ok) return;
    toast.info(`${appName()} didn't answer, so your browser is downloading it.`);
    fallback?.();
  });
  return true;
}

/** Open the app's Transfers (or its settings) window. */
export function openNativeWindow(which: "transfers" | "settings") {
  const app = nativeApp();
  const fn = which === "settings" ? app?.openSettings : app?.openTransfers;
  if (!app || !fn) return;
  const r = call(() => fn.call(app));
  void (r === false ? Promise.resolve(false) : answered(which === "settings" ? "openSettings" : "openTransfers", r)).then((ok) => {
    if (!ok) toast.error(`${appName()} didn't respond. Open it from the Loom icon in the notification area, or restart it.`);
  });
}

/** Live transfer summary from the app (null in a browser or before the first update). */
export function useNativeTransfers(): NativeTransfers | null {
  const [state, setState] = useState<NativeTransfers | null>(null);
  useEffect(() => {
    if (!hasNative("transfers")) return;
    const on = (e: Event) => setState((e as CustomEvent<NativeTransfers>).detail);
    window.addEventListener("loomapp:transfers", on);
    return () => window.removeEventListener("loomapp:transfers", on);
  }, []);
  return state;
}

/** Tell the app which folder is on screen. */
export function useNativeLocation(path: string | null, canWrite: boolean) {
  useEffect(() => {
    const app = nativeApp();
    if (!app?.setLocation) return;
    call(() => app.setLocation!({ path, canWrite }));
    return () => {
      call(() => app.setLocation?.({ path: null, canWrite: false }));
    };
  }, [path, canWrite]);
}

/**
 * Mount once (MainShell): routes "Download" links anywhere in the UI to the
 * app, and lets the app open a folder.
 */
export function useNativeBridge(navigate: (path: string) => void) {
  useEffect(() => {
    const app = nativeApp();
    if (!app) return;
    const onClick = (e: MouseEvent) => {
      if (!hasNative("downloads") || e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      // data-loom-browser: the browser download was chosen (or is the fallback).
      if (!a || a.dataset.loomBrowser != null) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== "/api/files/serve" || url.searchParams.get("download") !== "1") return;
      const path = url.searchParams.get("path");
      if (path == null) return;
      e.preventDefault();
      e.stopPropagation();
      const href = a.href;
      nativeDownload([{ path, name: a.getAttribute("download") || path.split("/").pop() || "download", type: "FILE" }], () => {
        const fallback = document.createElement("a");
        fallback.href = href;
        fallback.download = a.download;
        fallback.dataset.loomBrowser = "";
        document.body.appendChild(fallback);
        fallback.click();
        fallback.remove();
      });
    };
    const onNavigate = (e: Event) => {
      const path = (e as CustomEvent<{ path?: unknown }>).detail?.path;
      if (typeof path === "string") navigate(path);
    };
    const onToast = (e: Event) => {
      const d = (e as CustomEvent<{ kind?: unknown; message?: unknown; action?: unknown }>).detail;
      if (!d || typeof d.message !== "string") return;
      const opts = d.action === "transfers" ? { action: { label: "Open Transfers", onClick: () => openNativeWindow("transfers") } } : undefined;
      if (d.kind === "success") toast.success(d.message, opts);
      else if (d.kind === "error") toast.error(d.message, opts);
      else toast.info(d.message, opts);
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("loomapp:navigate", onNavigate);
    window.addEventListener("loomapp:toast", onToast);
    call(() => app.ready?.());
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("loomapp:navigate", onNavigate);
      window.removeEventListener("loomapp:toast", onToast);
    };
  }, [navigate]);
}
