"use client";

/**
 * File actions used across the UI. Each one talks to the API, resolves name
 * conflicts with the user, reports the outcome in a toast (with Undo where
 * possible) and announces the change so open views refresh.
 */

import { api, ApiError, parentOf } from "@/lib/client/api";
import { emitDirChange, onJobEvent, type JobEvent } from "@/lib/client/live";
import type { LNode } from "@/lib/client/types";
import { toast } from "@/components/ui/Toaster";
import { dialogs, validateFileName } from "@/components/ui/Dialog";
import { askCollision, resolveConflicts, type CollisionAction, type ConflictInfo, type Resolution } from "./CollisionDialog";

interface OpResult {
  path: string;
  status: "ok" | "skipped" | "conflict" | "error" | "queued";
  targetRel?: string;
  name?: string;
  error?: string;
  existing?: { name: string; type: "FILE" | "DIRECTORY" };
  id?: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const label = (dir: string) => (dir ? dir.split("/").pop()! : "Home");

type PinHook = (oldPath: string, newPath: string | null) => void;
let pinUpdater: PinHook | null = null;
/** MainShell registers the pin updater so renames/moves keep sidebar pins valid. */
export function registerPinUpdater(fn: PinHook | null) {
  pinUpdater = fn;
}

function summarize(results: OpResult[], verb: string) {
  const ok = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "error");
  if (failed.length && !ok.length) {
    toast.error(`Couldn't ${verb.toLowerCase()} ${failed.length > 1 ? plural(failed.length, "item") : `"${failed[0].path.split("/").pop()}"`}: ${failed[0].error ?? "failed"}`);
  } else if (failed.length) {
    toast.error(`${verb} ${plural(ok.length, "item")}, ${failed.length} failed: ${failed[0].error ?? ""}`);
  }
  return { ok, failed };
}

/**
 * Dry-run a copy/move, then ask about every file that already exists at the
 * destination (Replace / Skip / Keep both, "do this for all"). Same-named
 * folders merge. Returns null if the user cancelled.
 */
async function askAboutConflicts(op: "copy" | "move", sourcePaths: string[], destDir: string): Promise<Resolution | null> {
  const { conflicts, truncated } = await api<{ conflicts: ConflictInfo[]; truncated: boolean }>("/api/fs/conflicts", {
    method: "POST",
    json: { op, sourcePaths, destDir },
  });
  if (conflicts.length === 0) return { decisions: {}, defaultAction: "skip" };
  if (truncated) toast.info(`More than ${conflicts.length.toLocaleString()} files already exist there; your last choice applies to the rest.`);
  return resolveConflicts(conflicts, label(destDir));
}

// ─── move / copy ─────────────────────────────────────────────────────────────

interface TransferSummary {
  done: number;
  skipped: number;
  failed: number;
  errors: { path: string; error: string }[];
}

function outcome(verb: string, s: TransferSummary, destDir: string) {
  const parts = [`${verb} ${plural(s.done, "item")} to ${label(destDir)}`];
  if (s.skipped) parts.push(`skipped ${s.skipped}`);
  if (s.failed) parts.push(`${s.failed} failed${s.errors[0] ? `: ${s.errors[0].error}` : ""}`);
  return parts.join(", ");
}

export async function moveItems(paths: string[], destDir: string, opts: { undo?: boolean } = {}) {
  const sources = paths.filter((p) => parentOf(p) !== destDir);
  if (sources.length === 0) return;
  try {
    const res = await askAboutConflicts("move", sources, destDir);
    if (!res) return;
    const { results, summary } = await api<{ results: OpResult[]; summary: TransferSummary }>("/api/fs/move", {
      method: "POST",
      json: { sourcePaths: sources, destDir, ...res },
    });
    const ok = results.filter((r) => r.status === "ok");
    for (const r of ok) if (r.targetRel) pinUpdater?.(r.path, r.targetRel);
    emitDirChange([destDir, ...sources.map(parentOf)]);
    if (summary.done === 0 && summary.failed > 0) {
      toast.error(`Couldn't move: ${summary.errors[0]?.error ?? "failed"}`);
      return;
    }
    const message =
      summary.skipped || summary.failed || ok.length !== 1 ? outcome("Moved", summary, destDir) : `Moved "${ok[0].name}" to ${label(destDir)}`;
    const toastFn = summary.failed ? toast.error : toast.success;
    toastFn(message, {
      action:
        ok.length && opts.undo !== false
          ? {
              label: "Undo",
              onClick: async () => {
                const byParent = new Map<string, string[]>();
                for (const r of ok) byParent.set(parentOf(r.path), [...(byParent.get(parentOf(r.path)) ?? []), r.targetRel!]);
                for (const [orig, targets] of byParent) await moveItems(targets, orig, { undo: false });
              },
            }
          : undefined,
    });
  } catch (err) {
    toast.error((err as Error).message);
  }
}

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};

export async function copyItems(paths: string[], destDir: string) {
  if (paths.length === 0) return;
  try {
    const res = await askAboutConflicts("copy", paths, destDir);
    if (!res) return;
    const job = await api<{ jobId: string; bytesTotal: number; filesTotal: number; status?: string; summary?: TransferSummary }>("/api/fs/copy", {
      method: "POST",
      json: { sourcePaths: paths, destDir, ...res },
    });
    trackCopyJob(job, destDir);
  } catch (err) {
    toast.error((err as Error).message);
  }
}

/**
 * Show a copy's progress in a toast until it finishes: live events when the
 * event stream works, polling otherwise. The toast has a Cancel button.
 */
function trackCopyJob(job: { jobId: string; bytesTotal: number; filesTotal: number; status?: string; summary?: TransferSummary }, destDir: string) {
  const what = plural(job.filesTotal, "file");
  let finished = false;
  let lastEvent = Date.now();
  const cancel = { label: "Cancel", onClick: () => void api(`/api/fs/jobs/${job.jobId}`, { method: "DELETE" }).catch(() => {}) };
  const t = toast.loading(`Copying ${what}…`);
  toast.update(t, "loading", `Copying ${what}…`, { action: cancel, duration: 0 });

  const finish = (ev: JobEvent) => {
    if (finished) return;
    finished = true;
    stop();
    clearInterval(poll);
    emitDirChange([destDir]);
    const s = ev.summary;
    if (ev.status === "CANCELLED") toast.update(t, "info", s ? `Copy cancelled. ${outcome("Copied", s, destDir)}.` : "Copy cancelled.");
    else if (ev.status === "FAILED" || !s) toast.update(t, "error", `Copy failed: ${ev.error ?? s?.errors[0]?.error ?? "unknown error"}`);
    else toast.update(t, s.failed ? "error" : "success", outcome("Copied", s, destDir));
  };
  const onEvent = (ev: JobEvent) => {
    if (ev.id !== job.jobId) return;
    lastEvent = Date.now();
    if (ev.status === "RUNNING") {
      const size = ev.bytesTotal ? ` (${fmtBytes(ev.bytesDone ?? 0)} of ${fmtBytes(ev.bytesTotal)})` : "";
      toast.update(t, "loading", `Copying ${what}… ${ev.progress ?? 0}%${size}`, { action: cancel, duration: 0 });
    } else finish(ev);
  };
  const stop = onJobEvent(onEvent);
  // Fallback when live events don't arrive (proxy buffering, demo).
  const poll = setInterval(async () => {
    if (finished || Date.now() - lastEvent < 3000) return;
    try {
      const j = await api<{ status: string; progress: number; error?: string; payload?: { summary?: TransferSummary; bytesTotal?: number } }>(`/api/fs/jobs/${job.jobId}`);
      onEvent({ id: job.jobId, kind: "COPY", status: j.status, progress: j.progress, error: j.error ?? undefined, summary: j.payload?.summary });
      lastEvent = Date.now() - 1000;
    } catch {
      /* keep trying */
    }
  }, 2000);
  if (job.status && job.status !== "RUNNING") finish({ id: job.jobId, kind: "COPY", status: job.status, summary: job.summary });
}

// ─── rename ──────────────────────────────────────────────────────────────────

export async function renameItem(node: Pick<LNode, "relativePath" | "name" | "type">, newName: string): Promise<boolean> {
  newName = newName.trim() === newName ? newName : newName.trim();
  if (!newName || newName === node.name) return false;
  const invalid = validateFileName(newName);
  if (invalid) {
    toast.error(invalid);
    return false;
  }
  const call = (action: string) =>
    api<OpResult>("/api/fs/rename", { method: "POST", json: { sourcePath: node.relativePath, newName, action } });
  try {
    let r: OpResult;
    try {
      r = await call("ask");
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      const choice = await askCollision({ name: newName, destLabel: label(parentOf(node.relativePath)), remaining: 0, isFolder: node.type === "DIRECTORY" });
      if (!choice || choice.action === "skip") return false;
      r = await call(choice.action);
    }
    if (r.status !== "ok") {
      toast.error(r.error ?? "Rename failed");
      return false;
    }
    pinUpdater?.(node.relativePath, r.targetRel!);
    emitDirChange([parentOf(node.relativePath)]);
    const oldName = node.name;
    toast.success(`Renamed to "${r.name}"`, {
      action: {
        label: "Undo",
        onClick: () => renameItem({ relativePath: r.targetRel!, name: r.name!, type: node.type }, oldName),
      },
    });
    return true;
  } catch (err) {
    toast.error((err as Error).message);
    return false;
  }
}

export async function promptRename(node: Pick<LNode, "relativePath" | "name" | "type">) {
  const name = await dialogs.prompt({
    title: `Rename ${node.type === "DIRECTORY" ? "folder" : "file"}`,
    defaultValue: node.name,
    confirmLabel: "Rename",
    selectBaseName: node.type === "FILE",
    validate: validateFileName,
  });
  if (name) await renameItem(node, name);
}

// ─── trash / restore ─────────────────────────────────────────────────────────

export async function trashItems(nodes: Pick<LNode, "id" | "relativePath" | "name">[], opts: { confirm?: boolean } = {}) {
  if (nodes.length === 0) return;
  if (opts.confirm) {
    const ok = await dialogs.confirm({
      title: nodes.length === 1 ? `Move "${nodes[0].name}" to Trash?` : `Move ${plural(nodes.length, "item")} to Trash?`,
      message: "Items stay in Trash for 15 days before they're permanently deleted.",
      confirmLabel: "Move to Trash",
      danger: true,
    });
    if (!ok) return;
  }
  try {
    const { results } = await api<{ results: OpResult[] }>("/api/fs/trash", {
      method: "POST",
      json: { paths: nodes.map((n) => n.relativePath) },
    });
    const { ok } = summarize(results, "Deleted");
    for (const r of ok) pinUpdater?.(r.path, null);
    emitDirChange([...new Set(nodes.map((n) => parentOf(n.relativePath)))]);
    if (ok.length) {
      const okPaths = new Set(ok.map((r) => r.path));
      const ids = nodes.filter((n) => okPaths.has(n.relativePath) && n.id).map((n) => n.id);
      toast.success(ok.length === 1 ? `Moved "${nodes.find((n) => n.relativePath === ok[0].path)?.name}" to Trash` : `Moved ${plural(ok.length, "item")} to Trash`, {
        action: ids.length ? { label: "Undo", onClick: () => restoreItems(ids) } : undefined,
      });
    }
  } catch (err) {
    toast.error((err as Error).message);
  }
}

export async function restoreItems(fileNodeIds: string[], destDir?: string) {
  if (fileNodeIds.length === 0) return;
  const call = async (ids: string[], action: string) =>
    (await api<{ results: OpResult[] }>("/api/fs/restore", { method: "POST", json: { fileNodeIds: ids, action, destDir } })).results;
  try {
    let results = await call(fileNodeIds, "ask");
    const conflicts = results.filter((r) => r.status === "conflict");
    if (conflicts.length) {
      results = results.filter((r) => r.status !== "conflict");
      const byAction = new Map<CollisionAction, string[]>();
      for (let i = 0; i < conflicts.length; i++) {
        const c = conflicts[i];
        const choice = await askCollision({
          name: c.existing?.name ?? c.path.split("/").pop()!,
          destLabel: label(parentOf(c.path)),
          remaining: conflicts.length - i - 1,
          isFolder: c.existing?.type === "DIRECTORY",
        });
        if (!choice) break;
        const targets = choice.applyToAll ? conflicts.slice(i) : [c];
        for (const x of targets) byAction.set(choice.action, [...(byAction.get(choice.action) ?? []), x.id!]);
        if (choice.applyToAll) break;
      }
      byAction.delete("skip");
      for (const [action, ids] of byAction) results.push(...(await call(ids, action)));
    }
    const { ok } = summarize(results, "Restored");
    if (ok.length) toast.success(ok.length === 1 ? `Restored "${ok[0].name}"` : `Restored ${plural(ok.length, "item")}`);
    emitDirChange(["*"]);
  } catch (err) {
    toast.error((err as Error).message);
  }
}

// ─── create ──────────────────────────────────────────────────────────────────

export async function createFolder(parentPath: string): Promise<string | null> {
  const name = await dialogs.prompt({ title: "New folder", defaultValue: "Untitled folder", confirmLabel: "Create", validate: validateFileName });
  if (!name) return null;
  try {
    const r = await api<{ path: string; name: string }>("/api/fs/mkdir", { method: "POST", json: { parentPath, name } });
    emitDirChange([parentPath]);
    toast.success(`Created "${r.name}"`);
    return r.path;
  } catch (err) {
    toast.error((err as Error).message);
    return null;
  }
}

export async function createTextFile(parentPath: string): Promise<string | null> {
  const name = await dialogs.prompt({
    title: "New text file",
    defaultValue: "Untitled.md",
    confirmLabel: "Create",
    selectBaseName: true,
    validate: validateFileName,
  });
  if (!name) return null;
  try {
    const r = await api<{ path: string; name: string }>("/api/files/content", { method: "POST", json: { parentPath, name } });
    emitDirChange([parentPath]);
    toast.success(`Created "${r.name}"`);
    return r.path;
  } catch (err) {
    toast.error((err as Error).message);
    return null;
  }
}

// ─── favorites ───────────────────────────────────────────────────────────────

export async function setFavorite(nodeId: string, favorite: boolean): Promise<boolean> {
  try {
    const r = await api<{ favorited: boolean }>("/api/favorites", { method: "POST", json: { fileNodeId: nodeId, favorite } });
    return r.favorited;
  } catch (err) {
    toast.error((err as Error).message);
    return !favorite;
  }
}

// ─── download ────────────────────────────────────────────────────────────────

/**
 * Download files/folders. A single file downloads directly; anything else
 * is streamed as one ZIP by the server (a hidden form POST, so the browser's
 * own download manager handles it — no size limits, no memory use).
 */
export function downloadItems(nodes: Pick<LNode, "relativePath" | "type" | "name">[]) {
  if (nodes.length === 0) return;
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1" && !(nodes.length === 1 && nodes[0].type === "FILE")) {
    toast.info("ZIP downloads need a real Loom server — they aren't available in the demo.");
    return;
  }
  if (nodes.length === 1 && nodes[0].type === "FILE") {
    const a = document.createElement("a");
    a.href = `/api/files/serve?path=${encodeURIComponent(nodes[0].relativePath)}&download=1`;
    a.download = nodes[0].name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/download/zip";
  form.style.display = "none";
  for (const n of nodes) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "path";
    input.value = n.relativePath;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
  toast.info("Preparing your ZIP download…");
}
