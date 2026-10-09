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
 * The page calls LoomApp.ready() once it listens; apps hold events until then.
 *
 * The bridge never hands the page local file paths, and the page can't ask
 * the app to read a path: it can only pass files the user picked or dropped
 * here, or ask the app to show its own picker.
 */

import { useEffect, useState } from "react";

export type NativeCapability =
  | "uploads.files" // uploadFiles(): files picked/dropped in the page
  | "uploads.picker" // pickUpload(): the app's own file/folder picker
  | "downloads" // download(): the app's download manager
  | "transfers"; // openTransfers() + "loomapp:transfers" events

export interface NativeUploadItem {
  /** Path inside the destination folder (folder uploads include sub-folders) */
  relativePath: string;
  size: number;
  lastModified: number;
  /** Decided beforehand in the page's conflict dialog */
  conflict: "replace" | "keep_both";
}

export interface LoomAppBridge {
  apiVersion: number;
  platform: string;
  appVersion: string;
  capabilities: NativeCapability[];
  uploadFiles?(destDir: string, items: NativeUploadItem[], files: File[]): void;
  pickUpload?(destDir: string, mode: "files" | "folder"): void;
  download?(request: { items: { path: string; name: string; type: "FILE" | "DIRECTORY" }[] }): void;
  openTransfers?(): void;
  /** The folder on screen (null when not in a folder), for "upload here" from the app */
  setLocation?(location: { path: string | null; canWrite: boolean }): void;
  /** The user signed out in the page: the app should unpair */
  signedOut?(): void;
  /** The page is listening for "loomapp:*" events (sent after every page load) */
  ready?(): void;
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

/** Hand files to the app in batches (keeps each bridge message small). */
export function nativeUploadFiles(destDir: string, items: NativeUploadItem[], files: File[]) {
  const app = nativeApp();
  if (!app?.uploadFiles) return false;
  for (let i = 0; i < items.length; i += 500) app.uploadFiles(destDir, items.slice(i, i + 500), files.slice(i, i + 500));
  return true;
}

/** Ask the app to show its picker; false when the page should use its own input. */
export function nativePickUpload(destDir: string, mode: "files" | "folder"): boolean {
  const app = nativeApp();
  if (!app?.pickUpload || !hasNative("uploads.picker")) return false;
  app.pickUpload(destDir, mode);
  return true;
}

/** Download through the app; false when the browser should do it. */
export function nativeDownload(items: { path: string; name: string; type: "FILE" | "DIRECTORY" }[]): boolean {
  const app = nativeApp();
  if (!app?.download || !hasNative("downloads") || items.length === 0) return false;
  app.download({ items });
  return true;
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
    app.setLocation({ path, canWrite });
    return () => app.setLocation?.({ path: null, canWrite: false });
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
      if (!a) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== "/api/files/serve" || url.searchParams.get("download") !== "1") return;
      const path = url.searchParams.get("path");
      if (path == null) return;
      e.preventDefault();
      e.stopPropagation();
      nativeDownload([{ path, name: a.getAttribute("download") || path.split("/").pop() || "download", type: "FILE" }]);
    };
    const onNavigate = (e: Event) => {
      const path = (e as CustomEvent<{ path?: unknown }>).detail?.path;
      if (typeof path === "string") navigate(path);
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("loomapp:navigate", onNavigate);
    app.ready?.();
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("loomapp:navigate", onNavigate);
    };
  }, [navigate]);
}
