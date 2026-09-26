/**
 * file-ops.ts — every change Loom makes to the user's files goes through here.
 *
 * Safety rules enforced for all operations:
 *   - Paths and names are validated and ACL-checked on their normalized form
 *     (fs-guard.ts). Operations on folders require access to the whole tree.
 *   - Nothing is ever overwritten in place. "Replace" moves the existing item
 *     to Trash first, so it can be restored.
 *   - The filesystem change happens first; if updating the index then fails,
 *     the filesystem change is rolled back so disk and database agree.
 *   - Descendant index rows are rewritten with a single SQL statement, so
 *     moving a folder with 50,000 files is one fast UPDATE, not 50,000.
 *   - Paths are locked hierarchically for the duration of each operation.
 */

import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import type { FileNode, Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { MEDIA_ROOT, TRASH_DIR, resolveAndValidate, PathSecurityError } from "./path-security";
import { acquireMultiPathLock } from "./fs-locks";
import { AclEvaluator, rewriteAclPaths } from "./acl";
import {
  normalizeRelPath,
  validateName,
  resolveMediaPath,
  parentOf,
  baseName,
  joinRel,
  isSameOrDescendant,
  likeEscape,
} from "./fs-guard";
import {
  ensureDirectoryNodes,
  rewriteDescendantPaths,
  rewriteTrashOriginalPaths,
  sourceVersionOf,
  mimeTypeOf,
  upsertFileNodeFromDisk,
} from "./node-index";
import { publishChange } from "./events";
import { initFs } from "./fs-operations";
import { HttpError, badRequest, forbidden, notFound, type SessionUser } from "./http";

export type ConflictAction = "ask" | "skip" | "replace" | "keep_both";

export interface OpResult {
  path: string;
  status: "ok" | "skipped" | "conflict" | "queued" | "error";
  targetRel?: string;
  name?: string;
  error?: string;
  existing?: { name: string; type: "FILE" | "DIRECTORY" };
  jobId?: string;
  /** Legacy flags kept for older clients */
  success?: boolean;
  skipped?: boolean;
}

export const TRASH_RETENTION_DAYS = 15;
const TRASH_PREFIX = ".LoomTrash";

export function parseConflictAction(v: unknown, fallback: ConflictAction = "ask"): ConflictAction {
  return v === "skip" || v === "replace" || v === "keep_both" || v === "ask" ? v : fallback;
}

// ─── low-level helpers ───────────────────────────────────────────────────────

async function lstatOrNull(abs: string) {
  try {
    return await fs.lstat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Is `a` physically the same file as `b` (e.g. case-only rename on exFAT)? */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([lstatOrNull(a), lstatOrNull(b)]);
  return !!sa && !!sb && sa.ino === sb.ino && sa.dev === sb.dev && sa.ino !== 0;
}

/** Windows-style unique name in a directory: "a.jpg" -> "a (1).jpg"; folders get no extension split. */
export async function uniqueName(dirAbs: string, name: string, isDir: boolean): Promise<string> {
  const ext = isDir ? "" : path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = name;
  for (let n = 1; ; n++) {
    if (!(await lstatOrNull(path.join(dirAbs, candidate)))) return candidate;
    candidate = `${base} (${n})${ext}`;
    if (n > 10_000) throw new Error("Could not find a free name");
  }
}

/** rename(2), falling back to copy + delete when crossing filesystems. */
async function moveOnDisk(srcAbs: string, destAbs: string): Promise<void> {
  try {
    await fs.rename(srcAbs, destAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(srcAbs, destAbs, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    await fs.rm(srcAbs, { recursive: true, force: true });
  }
}

/** Case-only renames go through a temporary name so case-insensitive filesystems apply them. */
async function renameCaseOnly(srcAbs: string, destAbs: string): Promise<void> {
  const tmp = path.join(path.dirname(srcAbs), `.loom-rename-${randomUUID()}`);
  await fs.rename(srcAbs, tmp);
  try {
    await fs.rename(tmp, destAbs);
  } catch (err) {
    await fs.rename(tmp, srcAbs).catch(() => {});
    throw err;
  }
}

async function findLiveNode(rel: string) {
  return prisma.fileNode.findFirst({ where: { relativePath: rel, inTrash: false } });
}

/** Index an item that exists on disk but not in the DB (e.g. never scanned). */
async function findOrIndexNode(rel: string): Promise<FileNode> {
  const node = await findLiveNode(rel);
  if (node) return node;
  await ensureDirectoryNodes(parentOf(rel));
  return upsertFileNodeFromDisk(rel, { keepIdentity: true });
}

/** Remove index rows for a path that no longer exists on disk. */
async function deleteStaleSubtree(tx: Prisma.TransactionClient | typeof prisma, rel: string) {
  await tx.fileNode.deleteMany({
    where: {
      inTrash: false,
      OR: [{ relativePath: rel }, { relativePath: { startsWith: rel + "/" } }],
    },
  });
}

async function audit(userId: string | null, action: string, details: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { userId, action, details: details as object } }).catch((err) =>
    console.error("[audit] failed to write log entry", err)
  );
}

interface Target {
  rel: string;
  abs: string;
  name: string;
}

/**
 * Work out the final target for an item landing in `destDirAbs` under
 * `wantedName`, applying the conflict policy. Returns null for "skip" and
 * a conflict result for "ask".
 */
async function resolveTarget(
  user: SessionUser,
  acl: AclEvaluator,
  srcAbs: string | null,
  destDirRel: string,
  destDirAbs: string,
  wantedName: string,
  isDir: boolean,
  onConflict: ConflictAction
): Promise<Target | OpResult | null> {
  let name = wantedName;
  let abs = path.join(destDirAbs, name);
  const existing = await lstatOrNull(abs);
  if (existing && !(srcAbs && (await sameFile(srcAbs, abs)))) {
    switch (onConflict) {
      case "skip":
        return null;
      case "keep_both":
        name = await uniqueName(destDirAbs, wantedName, isDir);
        abs = path.join(destDirAbs, name);
        break;
      case "replace": {
        const existingRel = joinRel(destDirRel, name);
        if (srcAbs && srcAbs.startsWith(abs + path.sep)) {
          throw badRequest("Can't replace a folder with something inside it");
        }
        if (!acl.canAccessTree(existingRel)) throw forbidden("You can't replace that item");
        await trashLocked(user, existingRel, abs);
        break;
      }
      default:
        return {
          path: joinRel(destDirRel, name),
          status: "conflict",
          error: "An item with that name already exists",
          existing: { name, type: existing.isDirectory() ? "DIRECTORY" : "FILE" },
        };
    }
  }
  return { rel: joinRel(destDirRel, name), abs, name };
}

function isTarget(t: Target | OpResult | null): t is Target {
  return !!t && "abs" in t;
}

function ok(src: string, t: Target): OpResult {
  return { path: src, status: "ok", targetRel: t.rel, name: t.name, success: true };
}

function failed(src: string, err: unknown): OpResult {
  const code = (err as NodeJS.ErrnoException)?.code;
  const message =
    err instanceof HttpError
      ? err.message
      : err instanceof PathSecurityError
        ? /does not exist/.test(err.message)
          ? "Item not found — it may have been moved or deleted"
          : "Invalid path"
        : code === "ENOSPC"
          ? "The disk is full"
          : code === "EACCES" || code === "EPERM"
            ? "Loom doesn't have permission to change this on disk"
            : code === "ENOTEMPTY" || code === "EEXIST"
              ? "Something already exists at the destination"
              : "Operation failed";
  if (!(err instanceof HttpError) && !(err instanceof PathSecurityError)) console.error("[file-ops]", src, err);
  return { path: src, status: "error", error: message };
}

// ─── move / rename ───────────────────────────────────────────────────────────

/**
 * Move `srcRel` into `destDirRel`, optionally renaming it. Rename is a move
 * within the same directory.
 */
export async function moveItem(
  user: SessionUser,
  acl: AclEvaluator,
  opts: { srcRel: string; destDirRel: string; newName?: string; onConflict: ConflictAction }
): Promise<OpResult> {
  const srcRel = normalizeRelPath(opts.srcRel);
  try {
    if (!srcRel) throw badRequest("Can't move the root folder");
    const destDirRel = normalizeRelPath(opts.destDirRel);
    const newName = validateName(opts.newName ?? baseName(srcRel));
    const targetRelWanted = joinRel(destDirRel, newName);

    if (!acl.canAccessTree(srcRel)) throw forbidden("Access denied to source");
    if (!acl.canTraverse(destDirRel) || !acl.canAccess(targetRelWanted)) {
      throw forbidden("Access denied to destination");
    }
    if (isSameOrDescendant(destDirRel, srcRel)) {
      throw badRequest("Can't move a folder into itself");
    }
    if (targetRelWanted === srcRel) return { path: srcRel, status: "ok", targetRel: srcRel, name: newName, success: true };

    const srcAbs = await resolveMediaPath(srcRel, true);
    const destDirAbs = await resolveMediaPath(destDirRel, true);
    if (!(await fs.stat(destDirAbs)).isDirectory()) throw badRequest("Destination is not a folder");

    const release = await acquireMultiPathLock([srcAbs, path.join(destDirAbs, newName)]);
    try {
      const srcStat = await fs.lstat(srcAbs);
      const isDir = srcStat.isDirectory();
      const node = await findOrIndexNode(srcRel);

      const t = await resolveTarget(user, acl, srcAbs, destDirRel, destDirAbs, newName, isDir, opts.onConflict);
      if (!t) return { path: srcRel, status: "skipped", skipped: true };
      if (!isTarget(t)) return t;

      const caseOnly = await sameFile(srcAbs, t.abs);
      if (caseOnly) await renameCaseOnly(srcAbs, t.abs);
      else await moveOnDisk(srcAbs, t.abs);

      try {
        await prisma.$transaction(async (tx) => {
          if (!caseOnly) await deleteStaleSubtree(tx, t.rel);
          await tx.fileNode.update({
            where: { id: node.id },
            data: { relativePath: t.rel, parentPath: parentOf(t.rel), name: t.name },
          });
          if (isDir) {
            await rewriteDescendantPaths(tx, srcRel, t.rel, { fromTrash: false });
            await rewriteAclPaths(tx, srcRel, t.rel);
            await rewriteTrashOriginalPaths(tx, srcRel, t.rel);
          }
        });
      } catch (dbErr) {
        // Put the item back so the index and the disk agree.
        await (caseOnly ? renameCaseOnly(t.abs, srcAbs) : moveOnDisk(t.abs, srcAbs)).catch((e) =>
          console.error("[file-ops] rollback of move failed", srcRel, e)
        );
        throw dbErr;
      }

      const renamed = parentOf(srcRel) === destDirRel;
      await audit(user.id, renamed ? "RENAME" : "MOVE", { source: srcRel, dest: t.rel });
      await publishChange([parentOf(srcRel), destDirRel], [node.id]);
      return ok(srcRel, t);
    } finally {
      release();
    }
  } catch (err) {
    return failed(srcRel, err);
  }
}

// ─── copy ────────────────────────────────────────────────────────────────────

async function walkTree(rootAbs: string, onEntry: (abs: string, isDir: boolean) => void | Promise<void>) {
  const entries = await fs.readdir(rootAbs, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(rootAbs, e.name);
    if (e.isDirectory()) {
      await onEntry(abs, true);
      await walkTree(abs, onEntry);
    } else if (e.isFile()) {
      await onEntry(abs, false);
    }
  }
}

/** Index a freshly copied tree, reusing the source's content identities (no re-hashing). */
async function indexCopiedTree(srcRel: string, targetRel: string) {
  const sourceNodes = await prisma.fileNode.findMany({
    where: { inTrash: false, relativePath: { startsWith: srcRel + "/" }, type: "FILE" },
    select: { relativePath: true, contentIdentityId: true, sourceVersion: true, browserCompatible: true },
  });
  const bySub = new Map(sourceNodes.map((n) => [n.relativePath.slice(srcRel.length), n]));
  const rows: Prisma.FileNodeCreateManyInput[] = [];
  const targetAbs = path.join(MEDIA_ROOT, targetRel);
  await walkTree(targetAbs, async (abs, isDir) => {
    const rel = path.relative(MEDIA_ROOT, abs).split(path.sep).join("/");
    const st = await fs.stat(abs);
    const sv = isDir ? null : sourceVersionOf(st);
    const src = bySub.get(rel.slice(targetRel.length));
    const inherit = src && src.sourceVersion === sv;
    rows.push({
      relativePath: rel,
      parentPath: parentOf(rel),
      name: baseName(rel),
      type: isDir ? "DIRECTORY" : "FILE",
      mimeType: isDir ? null : mimeTypeOf(rel),
      size: isDir ? null : BigInt(st.size),
      modifiedAt: st.mtime,
      sourceVersion: sv,
      contentIdentityId: inherit ? src!.contentIdentityId : null,
      browserCompatible: inherit ? src!.browserCompatible : null,
    });
  });
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.fileNode.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
  }
}

export async function copyItem(
  user: SessionUser,
  acl: AclEvaluator,
  opts: { srcRel: string; destDirRel: string; onConflict: ConflictAction }
): Promise<OpResult> {
  const srcRel = normalizeRelPath(opts.srcRel);
  try {
    if (!srcRel) throw badRequest("Can't copy the root folder");
    const destDirRel = normalizeRelPath(opts.destDirRel);
    const name = baseName(srcRel);
    if (!acl.canAccessTree(srcRel)) throw forbidden("Access denied to source");
    if (!acl.canTraverse(destDirRel) || !acl.canAccess(joinRel(destDirRel, name))) {
      throw forbidden("Access denied to destination");
    }
    if (isSameOrDescendant(destDirRel, srcRel)) throw badRequest("Can't copy a folder into itself");

    const srcAbs = await resolveMediaPath(srcRel, true);
    const destDirAbs = await resolveMediaPath(destDirRel, true);
    if (!(await fs.stat(destDirAbs)).isDirectory()) throw badRequest("Destination is not a folder");

    const release = await acquireMultiPathLock([srcAbs, path.join(destDirAbs, name)]);
    try {
      const srcStat = await fs.stat(srcAbs);
      const isDir = srcStat.isDirectory();
      // Copying onto itself (same folder) always keeps both.
      const policy = destDirRel === parentOf(srcRel) ? "keep_both" : opts.onConflict;
      const t = await resolveTarget(user, acl, null, destDirRel, destDirAbs, name, isDir, policy);
      if (!t) return { path: srcRel, status: "skipped", skipped: true };
      if (!isTarget(t)) return t;

      if (isDir) {
        await fs.cp(srcAbs, t.abs, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        });
      } else {
        // COPYFILE_EXCL: never overwrite, even if something appeared meanwhile.
        await fs.copyFile(srcAbs, t.abs, fsConstants.COPYFILE_EXCL);
        await fs.utimes(t.abs, srcStat.atime, srcStat.mtime);
      }

      try {
        await prisma.$transaction(async (tx) => {
          await deleteStaleSubtree(tx, t.rel);
        });
        const srcNode = await findLiveNode(srcRel);
        const st = await fs.stat(t.abs);
        const inherit = srcNode && (isDir || srcNode.sourceVersion === sourceVersionOf(st));
        await upsertFileNodeFromDisk(t.rel, {
          contentIdentityId: inherit ? srcNode!.contentIdentityId : null,
        });
        if (isDir) await indexCopiedTree(srcRel, t.rel);
      } catch (dbErr) {
        await fs.rm(t.abs, { recursive: true, force: true }).catch(() => {});
        throw dbErr;
      }

      await audit(user.id, "COPY", { source: srcRel, dest: t.rel });
      await publishChange([destDirRel]);
      return ok(srcRel, t);
    } finally {
      release();
    }
  } catch (err) {
    return failed(srcRel, err);
  }
}

// ─── trash ───────────────────────────────────────────────────────────────────

/** Move an item into .LoomTrash. Caller must hold the lock for `abs`. */
async function trashLocked(user: SessionUser, rel: string, abs: string, kind = "DELETE") {
  await initFs();
  const node = await findOrIndexNode(rel);
  const trashName = `${randomUUID()}_${baseName(rel)}`;
  const trashAbs = path.join(TRASH_DIR, trashName);
  const newRoot = `${TRASH_PREFIX}/${trashName}`;
  const isDir = node.type === "DIRECTORY";

  await moveOnDisk(abs, trashAbs);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.fileNode.update({
        where: { id: node.id },
        data: { inTrash: true, relativePath: newRoot, parentPath: TRASH_PREFIX },
      });
      if (isDir) await rewriteDescendantPaths(tx, rel, newRoot, { setInTrash: true, fromTrash: false });
      await tx.trashItem.create({
        data: {
          fileNodeId: node.id,
          originalPath: rel,
          trashPath: trashName,
          deletedByUserId: user.id,
          expiresAt: new Date(Date.now() + TRASH_RETENTION_DAYS * 86_400_000),
          kind,
        },
      });
    });
  } catch (dbErr) {
    await moveOnDisk(trashAbs, abs).catch((e) => console.error("[file-ops] rollback of trash failed", rel, e));
    throw dbErr;
  }
  await audit(user.id, "TRASH", { path: rel, trashPath: trashName });
  await publishChange([parentOf(rel), TRASH_PREFIX], [node.id]);
  return node;
}

export async function trashItem(user: SessionUser, acl: AclEvaluator, relInput: string): Promise<OpResult> {
  const rel = normalizeRelPath(relInput);
  try {
    if (!rel) throw badRequest("Can't delete the root folder");
    if (!acl.canAccessTree(rel)) throw forbidden();
    const abs = await resolveMediaPath(rel, true);
    const release = await acquireMultiPathLock([abs]);
    try {
      await trashLocked(user, rel, abs);
      return { path: rel, status: "ok", success: true };
    } finally {
      release();
    }
  } catch (err) {
    return failed(rel, err);
  }
}

/**
 * Save a copy of a file into the trash as a "previous version" before it is
 * overwritten (used by the text editor). The original stays in place.
 */
export async function saveVersionToTrash(user: SessionUser, rel: string, abs: string): Promise<void> {
  await initFs();
  const trashName = `${randomUUID()}_${baseName(rel)}`;
  const trashAbs = path.join(TRASH_DIR, trashName);
  const st = await fs.stat(abs);
  await fs.copyFile(abs, trashAbs, fsConstants.COPYFILE_EXCL);
  await fs.utimes(trashAbs, st.atime, st.mtime);
  try {
    const live = await findLiveNode(rel);
    await prisma.$transaction(async (tx) => {
      const node = await tx.fileNode.create({
        data: {
          relativePath: `${TRASH_PREFIX}/${trashName}`,
          parentPath: TRASH_PREFIX,
          name: baseName(rel),
          type: "FILE",
          mimeType: mimeTypeOf(rel),
          size: BigInt(st.size),
          modifiedAt: st.mtime,
          sourceVersion: sourceVersionOf(st),
          contentIdentityId: live?.contentIdentityId ?? null,
          inTrash: true,
        },
      });
      await tx.trashItem.create({
        data: {
          fileNodeId: node.id,
          originalPath: rel,
          trashPath: trashName,
          deletedByUserId: user.id,
          expiresAt: new Date(Date.now() + TRASH_RETENTION_DAYS * 86_400_000),
          kind: "VERSION",
        },
      });
    });
  } catch (err) {
    await fs.rm(trashAbs, { force: true }).catch(() => {});
    throw err;
  }
}

// ─── restore ─────────────────────────────────────────────────────────────────

export async function restoreItem(
  user: SessionUser,
  acl: AclEvaluator,
  opts: { fileNodeId: string; destDirRel?: string | null; onConflict: ConflictAction }
): Promise<OpResult & { id: string }> {
  const id = opts.fileNodeId;
  try {
    await initFs();
    const item = await prisma.trashItem.findUnique({ where: { fileNodeId: id }, include: { fileNode: true } });
    if (!item) throw notFound("Trash item not found");
    if (!acl.isOwner && item.deletedByUserId !== user.id) throw forbidden("You can only restore items you deleted");

    const name = baseName(item.originalPath);
    const destDirRel =
      opts.destDirRel != null ? normalizeRelPath(opts.destDirRel) : parentOf(item.originalPath);
    if (!acl.canAccess(joinRel(destDirRel, name)) || !acl.canTraverse(destDirRel)) {
      throw forbidden("Access denied to the restore location");
    }

    const trashAbs = path.join(TRASH_DIR, item.trashPath);
    await resolveAndValidate(item.trashPath, "trash", true).catch(() => {
      throw notFound("The item is missing from the trash folder on disk");
    });

    // Recreate the parent folder if it was deleted or moved away meanwhile.
    const destDirAbs = await resolveMediaPath(destDirRel);
    await fs.mkdir(destDirAbs, { recursive: true });
    await ensureDirectoryNodes(destDirRel);

    const release = await acquireMultiPathLock([trashAbs, path.join(destDirAbs, name)]);
    try {
      const isDir = item.fileNode.type === "DIRECTORY";
      const t = await resolveTarget(user, acl, null, destDirRel, destDirAbs, name, isDir, opts.onConflict);
      if (!t) return { id, path: item.originalPath, status: "skipped", skipped: true };
      if (!isTarget(t)) return { ...t, id, error: "Something already exists at the original location" };

      await moveOnDisk(trashAbs, t.abs);
      const trashRoot = `${TRASH_PREFIX}/${item.trashPath}`;
      try {
        await prisma.$transaction(async (tx) => {
          await deleteStaleSubtree(tx, t.rel);
          await tx.fileNode.update({
            where: { id: item.fileNodeId },
            data: { inTrash: false, relativePath: t.rel, parentPath: parentOf(t.rel), name: t.name },
          });
          if (isDir) await rewriteDescendantPaths(tx, trashRoot, t.rel, { setInTrash: false, fromTrash: true });
          await tx.trashItem.delete({ where: { id: item.id } });
        });
      } catch (dbErr) {
        await moveOnDisk(t.abs, trashAbs).catch((e) => console.error("[file-ops] rollback of restore failed", e));
        throw dbErr;
      }
      await audit(user.id, "RESTORE", { path: t.rel, trashPath: item.trashPath });
      await publishChange([destDirRel, TRASH_PREFIX], [item.fileNodeId]);
      return { ...ok(item.originalPath, t), id };
    } finally {
      release();
    }
  } catch (err) {
    return { ...failed(id, err), id };
  }
}

// ─── permanent delete ────────────────────────────────────────────────────────

async function purgeTrashItem(item: { id: string; fileNodeId: string; trashPath: string }) {
  const trashAbs = path.join(TRASH_DIR, item.trashPath);
  await resolveAndValidate(item.trashPath, "trash").catch(() => {
    throw badRequest("Invalid trash path");
  });
  const release = await acquireMultiPathLock([trashAbs]);
  try {
    // Index first: if removing bytes then fails midway, the scanner's trash
    // sweep deletes the leftovers. The reverse order could leave rows
    // pointing at deleted files.
    await prisma.$transaction(async (tx) => {
      await tx.fileNode.deleteMany({
        where: { relativePath: { startsWith: `${TRASH_PREFIX}/${item.trashPath}/` } },
      });
      await tx.fileNode.delete({ where: { id: item.fileNodeId } });
    });
    await fs.rm(trashAbs, { recursive: true, force: true });
  } finally {
    release();
  }
}

export async function deleteTrashItemForever(user: SessionUser, trashItemId: string) {
  const item = await prisma.trashItem.findUnique({ where: { id: trashItemId } });
  if (!item) throw notFound("Trash item not found");
  if (user.role !== "OWNER" && item.deletedByUserId !== user.id) throw forbidden();
  await purgeTrashItem(item);
  await audit(user.id, "PERMANENT_DELETE", { originalPath: item.originalPath, trashPath: item.trashPath });
  await publishChange([TRASH_PREFIX]);
}

/** Owner empties everything; Family users empty only what they deleted. */
export async function emptyTrash(user: SessionUser) {
  const items = await prisma.trashItem.findMany({
    where: user.role === "OWNER" ? undefined : { deletedByUserId: user.id },
  });
  let deleted = 0;
  const errors: { id: string; error: string }[] = [];
  for (const item of items) {
    try {
      await purgeTrashItem(item);
      deleted++;
    } catch (err) {
      console.error("[file-ops] empty trash failed for", item.trashPath, err);
      errors.push({ id: item.id, error: "Could not delete" });
    }
  }
  await audit(user.id, "EMPTY_TRASH", { count: deleted, total: items.length });
  await publishChange([TRASH_PREFIX]);
  return { deletedCount: deleted, errors };
}

// ─── mkdir ───────────────────────────────────────────────────────────────────

export async function makeDirectory(user: SessionUser, acl: AclEvaluator, parentInput: string, nameInput: string) {
  const parentRel = normalizeRelPath(parentInput);
  const wanted = validateName(nameInput);
  if (!acl.canTraverse(parentRel) || !acl.canAccess(joinRel(parentRel, wanted))) throw forbidden();
  const parentAbs = await resolveMediaPath(parentRel, true);
  if (!(await fs.stat(parentAbs)).isDirectory()) throw badRequest("Parent is not a folder");

  // mkdir without {recursive} is atomic: EEXIST means the name is taken.
  let name = wanted;
  for (let n = 1; ; n++) {
    try {
      await fs.mkdir(path.join(parentAbs, name));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 1000) throw err;
      name = `${wanted} (${n})`;
    }
  }
  const rel = joinRel(parentRel, name);
  try {
    await ensureDirectoryNodes(parentRel);
    await prisma.fileNode.deleteMany({ where: { inTrash: false, relativePath: { startsWith: rel + "/" } } });
    await upsertFileNodeFromDisk(rel);
  } catch (err) {
    await fs.rmdir(path.join(parentAbs, name)).catch(() => {});
    throw err;
  }
  await audit(user.id, "MKDIR", { path: rel });
  await publishChange([parentRel]);
  return { path: rel, name };
}

// ─── misc ────────────────────────────────────────────────────────────────────

/** Sum of sizes of all live files under a folder (uses the pattern index). */
export async function folderStats(rel: string) {
  const prefix = rel ? likeEscape(rel) + "/%" : "%";
  const rows = await prisma.$queryRaw<{ size: bigint | null; files: bigint; dirs: bigint }[]>`
    SELECT COALESCE(SUM("size") FILTER (WHERE type = 'FILE'), 0)::bigint AS size,
           COUNT(*) FILTER (WHERE type = 'FILE') AS files,
           COUNT(*) FILTER (WHERE type = 'DIRECTORY') AS dirs
    FROM "file_nodes"
    WHERE "inTrash" = false AND "isVisible" = true AND "relativePath" LIKE ${prefix} ESCAPE '\\'`;
  const r = rows[0];
  return { size: r?.size ?? BigInt(0), files: Number(r?.files ?? 0), dirs: Number(r?.dirs ?? 0) };
}
