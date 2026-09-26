"use client";

/**
 * File actions used across the UI. Each one talks to the API, resolves name
 * conflicts with the user, reports the outcome in a toast (with Undo where
 * possible) and announces the change so open views refresh.
 */

import { api, ApiError, parentOf } from "@/lib/client/api";
import { emitDirChange } from "@/lib/client/live";
import type { LNode } from "@/lib/client/types";
import { toast } from "@/components/ui/Toaster";
import { dialogs, validateFileName } from "@/components/ui/Dialog";
import { askCollision, type CollisionAction } from "./CollisionDialog";

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

/**
 * Run a batch operation, then ask about conflicts one by one (with "apply to
 * all") and retry those with the chosen action.
 */
async function runWithConflicts(
  sources: string[],
  call: (paths: string[], action: CollisionAction | "ask") => Promise<OpResult[]>,
  destDir: string
): Promise<OpResult[]> {
  let results = await call(sources, "ask");
  const conflicts = results.filter((r) => r.status === "conflict");
  if (conflicts.length === 0) return results;

  const decided = new Map<string, CollisionAction>();
  let all: CollisionAction | null = null;
  for (let i = 0; i < conflicts.length; i++) {
    const c = conflicts[i];
    if (all) {
      decided.set(c.path, all);
      continue;
    }
    const choice = await askCollision({
      name: c.existing?.name ?? c.path.split("/").pop()!,
      destLabel: label(destDir),
      remaining: conflicts.length - i - 1,
      isFolder: c.existing?.type === "DIRECTORY",
    });
    if (!choice) break; // dialog closed: treat the rest as skipped
    decided.set(c.path, choice.action);
    if (choice.applyToAll) all = choice.action;
  }

  results = results.filter((r) => r.status !== "conflict");
  const byAction = new Map<CollisionAction, string[]>();
  for (const c of conflicts) {
    const a = decided.get(c.path) ?? "skip";
    if (a === "skip") {
      results.push({ path: c.path, status: "skipped" });
      continue;
    }
    byAction.set(a, [...(byAction.get(a) ?? []), c.path]);
  }
  for (const [action, paths] of byAction) results.push(...(await call(paths, action)));
  return results;
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

// ─── move / copy ─────────────────────────────────────────────────────────────

export async function moveItems(paths: string[], destDir: string, opts: { undo?: boolean } = {}) {
  const sources = paths.filter((p) => parentOf(p) !== destDir);
  if (sources.length === 0) return;
  try {
    const results = await runWithConflicts(
      sources,
      async (p, action) => (await api<{ results: OpResult[] }>("/api/fs/move", { method: "POST", json: { sourcePaths: p, destDir, action } })).results,
      destDir
    );
    const { ok } = summarize(results, "Moved");
    for (const r of ok) if (r.targetRel) pinUpdater?.(r.path, r.targetRel);
    emitDirChange([destDir, ...sources.map(parentOf)]);
    if (ok.length && opts.undo !== false) {
      toast.success(`Moved ${ok.length === 1 ? `"${ok[0].name}"` : plural(ok.length, "item")} to ${label(destDir)}`, {
        action: {
          label: "Undo",
          onClick: async () => {
            const byParent = new Map<string, string[]>();
            for (const r of ok) byParent.set(parentOf(r.path), [...(byParent.get(parentOf(r.path)) ?? []), r.targetRel!]);
            for (const [orig, targets] of byParent) await moveItems(targets, orig, { undo: false });
          },
        },
      });
    }
  } catch (err) {
    toast.error((err as Error).message);
  }
}

export async function copyItems(paths: string[], destDir: string) {
  if (paths.length === 0) return;
  const t = toast.loading(`Copying ${plural(paths.length, "item")}…`);
  try {
    const results = await runWithConflicts(
      paths,
      async (p, action) => (await api<{ results: OpResult[] }>("/api/fs/copy", { method: "POST", json: { sourcePaths: p, destDir, action } })).results,
      destDir
    );
    toast.dismiss(t);
    const { ok } = summarize(results, "Copied");
    if (ok.length) toast.success(`Copied ${ok.length === 1 ? `"${ok[0].name}"` : plural(ok.length, "item")} to ${label(destDir)}`);
    emitDirChange([destDir]);
  } catch (err) {
    toast.dismiss(t);
    toast.error((err as Error).message);
  }
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
      const choice = await askCollision({
        name: conflicts[0].existing?.name ?? conflicts[0].path.split("/").pop()!,
        destLabel: label(parentOf(conflicts[0].path)),
        remaining: conflicts.length - 1,
        isFolder: conflicts[0].existing?.type === "DIRECTORY",
      });
      results = results.filter((r) => r.status !== "conflict");
      if (choice && choice.action !== "skip") {
        const ids = choice.applyToAll ? conflicts.map((c) => c.id!) : [conflicts[0].id!];
        results.push(...(await call(ids, choice.action)));
      }
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
