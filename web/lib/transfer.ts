/**
 * transfer.ts — copy/move with Windows-style conflict handling.
 *
 *   1. previewTransfer / previewUpload (dry run) list every file that already
 *      exists at the destination. Folders with the same name aren't conflicts:
 *      they merge, and only the files inside them that collide are listed.
 *   2. The browser asks the user about each one (Replace / Skip / Keep both,
 *      with "do this for all"), and sends the decisions back.
 *   3. runTransfer does the work, item by item, through the regular move/copy
 *      operations in file-ops.ts (locking, Trash-instead-of-overwrite,
 *      rollback, crash-safe copies).
 *
 * Conflict keys are paths relative to the destination folder, e.g. copying
 * "Photos" into "Backup" gives keys like "Photos/2024/a.jpg".
 */

import fs from "fs/promises";
import path from "path";
import { prisma } from "./prisma";
import type { AclEvaluator } from "./acl";
import {
  normalizeRelPath,
  resolveMediaPath,
  parentOf,
  baseName,
  joinRel,
  validateRelativeFilePath,
  isSameOrDescendant,
  INTERNAL_NAMES,
} from "./fs-guard";
import { isLoomTempName } from "./fs-journal";
import { copyItem, moveItem, lstatOrNull, sameFile, type OpResult, type ProgressFn } from "./file-ops";
import { publishChange } from "./events";
import { badRequest, forbidden, type SessionUser } from "./http";

export type FileAction = "skip" | "replace" | "keep_both";
export type TransferOp = "copy" | "move";

export function parseFileAction(v: unknown, fallback: FileAction = "skip"): FileAction {
  return v === "skip" || v === "replace" || v === "keep_both" ? v : fallback;
}

/** Decisions from the browser: conflict key → action. */
export function parseDecisions(v: unknown): Record<string, FileAction> {
  const out: Record<string, FileAction> = {};
  if (v && typeof v === "object") {
    for (const [k, a] of Object.entries(v as Record<string, unknown>).slice(0, 50_000)) {
      if (a === "skip" || a === "replace" || a === "keep_both") out[k] = a;
    }
  }
  return out;
}

export interface ItemInfo {
  type: "FILE" | "DIRECTORY";
  size: number | null;
  modifiedAt: string | null;
}

export interface ConflictInfo {
  key: string;
  name: string;
  existing: ItemInfo;
  incoming: ItemInfo;
  /** "file": both are files. "mismatch": a file and a folder share the name (only Keep both / Skip make sense). */
  kind: "file" | "mismatch";
  /** Same size and (within 2 s) the same modified time: very likely the same file. */
  same: boolean;
}

const MAX_CONFLICTS = 20_000;

function info(st: import("fs").Stats): ItemInfo {
  const dir = st.isDirectory();
  return { type: dir ? "DIRECTORY" : "FILE", size: dir ? null : st.size, modifiedAt: st.mtime.toISOString() };
}

function looksSame(a: ItemInfo, b: ItemInfo): boolean {
  if (a.type !== "FILE" || b.type !== "FILE" || a.size !== b.size || !a.modifiedAt || !b.modifiedAt) return false;
  return Math.abs(Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt)) < 2000;
}

const skipEntry = (name: string) => INTERNAL_NAMES.has(name) || isLoomTempName(name);

async function checkSources(acl: AclEvaluator, sourcePaths: unknown, destDirInput: unknown) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) throw badRequest("sourcePaths is required");
  const destDir = normalizeRelPath(destDirInput);
  if (!acl.canTraverse(destDir)) throw forbidden("Access denied to destination");
  const destDirAbs = await resolveMediaPath(destDir, true);
  if (!(await fs.stat(destDirAbs)).isDirectory()) throw badRequest("Destination is not a folder");
  const sources = sourcePaths.slice(0, 5000).map((p) => normalizeRelPath(p)).filter(Boolean);
  for (const src of sources) {
    if (isSameOrDescendant(destDir, src)) throw badRequest("Can't put a folder inside itself");
  }
  return { destDir, destDirAbs, sources };
}

// ─── preview ─────────────────────────────────────────────────────────────────

/** Dry run of a copy/move: the files that would collide. Nothing is changed. */
export async function previewTransfer(
  acl: AclEvaluator,
  op: TransferOp,
  sourcePaths: unknown,
  destDirInput: unknown
): Promise<{ conflicts: ConflictInfo[]; truncated: boolean }> {
  const { destDir, destDirAbs, sources } = await checkSources(acl, sourcePaths, destDirInput);
  const conflicts: ConflictInfo[] = [];

  const compare = async (srcAbs: string, dstAbs: string, key: string): Promise<void> => {
    if (conflicts.length >= MAX_CONFLICTS) return;
    const d = await lstatOrNull(dstAbs);
    if (!d) return;
    const s = await lstatOrNull(srcAbs);
    if (!s || s.isSymbolicLink() || d.isSymbolicLink()) return;
    if (s.isDirectory() && d.isDirectory()) {
      for (const e of await fs.readdir(srcAbs, { withFileTypes: true })) {
        if (skipEntry(e.name) || e.isSymbolicLink()) continue;
        await compare(path.join(srcAbs, e.name), path.join(dstAbs, e.name), `${key}/${e.name}`);
      }
      return;
    }
    const incoming = info(s);
    const existing = info(d);
    const kind = s.isDirectory() === d.isDirectory() ? "file" : "mismatch";
    conflicts.push({ key, name: baseName(key), existing, incoming, kind, same: kind === "file" && looksSame(existing, incoming) });
  };

  for (const src of sources) {
    if (!acl.canAccessTree(src)) throw forbidden("Access denied to source");
    // Copying into the same folder always keeps both; moving there is a no-op.
    if (parentOf(src) === destDir) continue;
    const srcAbs = await resolveMediaPath(src, true);
    const name = baseName(src);
    const dstAbs = path.join(destDirAbs, name);
    if (await sameFile(srcAbs, dstAbs)) continue;
    await compare(srcAbs, dstAbs, name);
  }
  return { conflicts, truncated: conflicts.length >= MAX_CONFLICTS };
}

/**
 * Dry run of an upload: which of these files (paths relative to `destDir`)
 * already exist. `size`/`lastModified` of the incoming files let us flag
 * identical ones (e.g. re-uploading a folder after an interrupted upload).
 */
export async function previewUpload(
  acl: AclEvaluator,
  destDirInput: unknown,
  files: unknown
): Promise<{ conflicts: ConflictInfo[]; truncated: boolean }> {
  if (!Array.isArray(files)) throw badRequest("files is required");
  const destDir = normalizeRelPath(destDirInput);
  if (!acl.canTraverse(destDir)) throw forbidden("You can't upload here");
  const destDirAbs = await resolveMediaPath(destDir, true);
  const conflicts: ConflictInfo[] = [];
  for (const f of files.slice(0, MAX_CONFLICTS)) {
    const entry = f as { path?: unknown; size?: unknown; lastModified?: unknown };
    let rel: string;
    try {
      rel = validateRelativeFilePath(entry.path);
    } catch {
      continue; // the upload itself will report the bad name
    }
    const d = await lstatOrNull(path.join(destDirAbs, ...rel.split("/")));
    if (!d || d.isSymbolicLink()) continue;
    const size = Number(entry.size);
    const lm = Number(entry.lastModified);
    const incoming: ItemInfo = {
      type: "FILE",
      size: Number.isFinite(size) ? size : null,
      modifiedAt: Number.isFinite(lm) && lm > 0 ? new Date(lm).toISOString() : null,
    };
    const existing = info(d);
    const kind = d.isDirectory() ? "mismatch" : "file";
    conflicts.push({ key: rel, name: baseName(rel), existing, incoming, kind, same: kind === "file" && looksSame(existing, incoming) });
  }
  return { conflicts, truncated: files.length > MAX_CONFLICTS };
}

// ─── run ─────────────────────────────────────────────────────────────────────

export interface TransferSummary {
  done: number;
  skipped: number;
  failed: number;
  errors: { path: string; error: string }[];
}

export interface TransferOptions {
  op: TransferOp;
  sources: string[];
  destDir: string;
  /** Decision per conflict key (from the preview). */
  decisions: Record<string, FileAction>;
  /** For conflicts that weren't in the preview (appeared since): the "do this for all" choice, else skip. */
  defaultAction: FileAction;
  onProgress?: ProgressFn;
  /** Stop between (and during) items. What's already done stays done. */
  signal?: AbortSignal;
}

/** Totals for progress reporting: bytes and files under the sources. */
export async function measureSources(sources: string[]): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (abs: string) => {
    const st = await lstatOrNull(abs);
    if (!st || st.isSymbolicLink()) return;
    if (st.isFile()) {
      bytes += st.size;
      files++;
    } else if (st.isDirectory()) {
      for (const e of await fs.readdir(abs, { withFileTypes: true }).catch(() => [])) {
        if (!skipEntry(e.name)) await walk(path.join(abs, e.name));
      }
    }
  };
  for (const s of sources) await walk(await resolveMediaPath(s, true).catch(() => ""));
  return { bytes, files };
}

/** Check a copy/move request up front (so a background job can fail fast). */
export async function validateTransfer(acl: AclEvaluator, sourcePaths: unknown, destDirInput: unknown) {
  const { destDir, sources } = await checkSources(acl, sourcePaths, destDirInput);
  for (const src of sources) if (!acl.canAccessTree(src)) throw forbidden("Access denied to source");
  return { destDir, sources };
}

export async function runTransfer(user: SessionUser, acl: AclEvaluator, opts: TransferOptions): Promise<{ results: OpResult[]; summary: TransferSummary }> {
  const { op, destDir, decisions, defaultAction, signal } = opts;
  const cancelled = () => signal?.aborted === true;
  // Checking the signal on every chunk makes a cancel stop mid-file too; the
  // half-copied temp file is then removed by copyIntoPlace.
  const onProgress: ProgressFn | undefined = opts.onProgress
    ? (b, f) => {
        if (cancelled()) throw Object.assign(new Error("Cancelled"), { code: "ECANCELED" });
        opts.onProgress!(b, f);
      }
    : undefined;
  const destDirAbs = await resolveMediaPath(destDir, true);
  const results: OpResult[] = [];
  const summary: TransferSummary = { done: 0, skipped: 0, failed: 0, errors: [] };

  const record = (r: OpResult) => {
    if (r.status === "ok") summary.done++;
    else if (r.status === "skipped") summary.skipped++;
    else if (r.status === "error" || r.status === "conflict") {
      summary.failed++;
      if (summary.errors.length < 20) summary.errors.push({ path: r.path, error: r.error ?? "Failed" });
    }
  };

  /** Move/copy one item (file or whole folder) into `intoDir` with a conflict policy. */
  const single = async (srcRel: string, intoDir: string, action: FileAction): Promise<OpResult> => {
    if (op === "move") return moveItem(user, acl, { srcRel, destDirRel: intoDir, onConflict: action });
    return copyItem(user, acl, { srcRel, destDirRel: intoDir, onConflict: action, onProgress });
  };

  /** Skipped files still count towards progress, so the bar reaches 100%. */
  const skipProgress = async (abs: string) => {
    if (!onProgress) return;
    const st = await lstatOrNull(abs);
    if (st?.isFile()) onProgress(st.size, 1);
    else if (st?.isDirectory()) {
      const m = await measureDir(abs);
      onProgress(m.bytes, m.files);
    }
  };

  const merge = async (srcRel: string, intoDir: string, key: string): Promise<void> => {
    if (cancelled()) return;
    const srcAbs = await resolveMediaPath(srcRel, true);
    const name = baseName(srcRel);
    const dstRel = joinRel(intoDir, name);
    const dstAbs = path.join(await resolveMediaPath(intoDir, true), name);
    const s = await lstatOrNull(srcAbs);
    const d = await lstatOrNull(dstAbs);
    if (!s) return;

    if (!d) {
      // Nothing there: move/copy the whole item in one go.
      const r = await single(srcRel, intoDir, defaultAction);
      record(r);
      results.push(r);
      return;
    }

    if (s.isDirectory() && d.isDirectory() && !d.isSymbolicLink()) {
      if (!acl.canAccessTree(srcRel)) throw forbidden("Access denied to source");
      for (const e of await fs.readdir(srcAbs, { withFileTypes: true })) {
        if (skipEntry(e.name) || e.isSymbolicLink()) continue;
        await merge(joinRel(srcRel, e.name), dstRel, `${key}/${e.name}`);
      }
      if (op === "move") await removeIfEmpty(srcRel, srcAbs);
      return;
    }

    let action = decisions[key] ?? defaultAction;
    // Never replace a folder with a file or vice versa; keep both instead.
    if (action === "replace" && s.isDirectory() !== d.isDirectory()) action = "keep_both";
    if (action === "skip") {
      await skipProgress(srcAbs);
      const r: OpResult = { path: srcRel, status: "skipped", skipped: true };
      record(r);
      results.push(r);
      return;
    }
    const r = await single(srcRel, intoDir, action);
    record(r);
    results.push(r);
  };

  for (const src of opts.sources) {
    if (cancelled()) break;
    try {
      if (!acl.canAccessTree(src)) throw forbidden("Access denied to source");
      const srcAbs = await resolveMediaPath(src, true);
      const name = baseName(src);
      const dstAbs = path.join(destDirAbs, name);
      if (parentOf(src) === destDir) {
        if (op === "move") continue; // already there
        const r = await single(src, destDir, "keep_both"); // copy next to itself
        record(r);
        results.push(r);
        continue;
      }
      if (await sameFile(srcAbs, dstAbs)) continue;
      await merge(src, destDir, name);
    } catch (err) {
      const r: OpResult = { path: src, status: "error", error: (err as Error).message || "Failed" };
      record(r);
      results.push(r);
    }
  }
  return { results, summary };
}

async function measureDir(abs: string) {
  let bytes = 0;
  let files = 0;
  for (const e of await fs.readdir(abs, { withFileTypes: true }).catch(() => [])) {
    if (skipEntry(e.name) || e.isSymbolicLink()) continue;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) {
      const m = await measureDir(p);
      bytes += m.bytes;
      files += m.files;
    } else if (e.isFile()) {
      bytes += (await fs.stat(p)).size;
      files++;
    }
  }
  return { bytes, files };
}

/** After merging a folder by moving its contents, remove it if nothing was left behind. */
async function removeIfEmpty(rel: string, abs: string) {
  const left = (await fs.readdir(abs).catch(() => ["?"])).filter((n) => !isLoomTempName(n));
  if (left.length) return; // some files were skipped: the folder stays
  try {
    await fs.rmdir(abs);
  } catch {
    return;
  }
  await prisma.fileNode.deleteMany({ where: { relativePath: rel, inTrash: false } });
  await publishChange([parentOf(rel)]);
}
