/**
 * FULL_RESCAN — reconcile the index with the disk.
 *
 * The walk is metadata only: it compares size + mtime with what is indexed
 * and never reads file contents. New or changed photos/videos, and ones whose
 * thumbnails are missing, are queued as PROCESS_FILE jobs that the worker
 * lane handles in parallel — so the scan itself finishes quickly.
 *
 * Each folder is loaded with one query (by parentPath) and diffed against
 * readdir(), and rows for items that vanished from that folder are removed
 * right there. If the media root looks unmounted (empty while the index is
 * not) the scan stops before removing anything.
 */
import { readdir, stat, access, readFile, lstat, rm } from "fs/promises";
import { join } from "path";
import { constants, type Dirent } from "fs";
import mime from "mime-types";
import { Prisma } from "@prisma/client";
import {
  prisma,
  log,
  MEDIA_ROOT,
  isIgnoredName,
  isLoomTempName,
  JOURNAL_DIR,
  sourceVersionOf,
  setStatus,
  publishChange,
  THUMB_PROFILE,
  PREVIEW_PROFILE,
  IMAGE_EXTENSIONS,
} from "./common.js";
import { isProcessable } from "./process.js";
import { cacheFileExists } from "./media.js";
import { expireTrash, runOrphanGC, sweepOrphanTrash } from "./maintenance.js";

interface Stats {
  dirsChecked: number;
  filesChecked: number;
  filesAdded: number;
  filesChanged: number;
  removed: number;
  queued: number;
  errors: number;
}

function likePrefix(s: string) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c) + "/%";
}

/**
 * Temp paths the web app is still writing (listed in its journal). Anything
 * else with a Loom temp name is a leftover from an interrupted operation.
 */
async function journalTemps(): Promise<Set<string>> {
  const live = new Set<string>();
  for (const f of await readdir(JOURNAL_DIR).catch(() => [] as string[])) {
    try {
      const e = JSON.parse(await readFile(join(JOURNAL_DIR, f), "utf8"));
      if (typeof e.tempAbs === "string") live.add(e.tempAbs);
      if (typeof e.finalAbs === "string") live.add(e.finalAbs);
    } catch {
      /* ignore */
    }
  }
  return live;
}

/**
 * Remove an unfinished temp file/folder left behind by an interrupted copy,
 * edit or rename — never one that's in use (in the journal, or touched in the
 * last hour). These are never shown in Loom and never indexed.
 */
async function discardStaleTemp(abs: string, live: Set<string>) {
  if (live.has(abs)) return;
  const st = await lstat(abs).catch(() => null);
  if (!st || Date.now() - st.mtimeMs < 60 * 60 * 1000) return;
  await rm(abs, { recursive: true, force: true }).catch(() => {});
  log("INFO", `Removed an unfinished temporary file left by an interrupted operation: ${abs}`);
}

/**
 * Fix rows whose parentPath doesn't match their relativePath. Only rows
 * written by an older Loom (e.g. while rolled back after an update) can be
 * wrong: the column didn't exist then, so they got the default ''. Folders
 * are listed by parentPath, so without this they'd show up in the root.
 */
export async function repairParentPaths(): Promise<void> {
  const fixed = await prisma.$executeRaw`
    UPDATE "file_nodes"
    SET "parentPath" = regexp_replace("relativePath", '/[^/]*$', '')
    WHERE "parentPath" = '' AND position('/' in "relativePath") > 0`;
  if (fixed) log("INFO", `Repaired the parent folder of ${fixed} index row(s) written by an older version`);
}

export async function runFullRescan(jobId: string): Promise<void> {
  log("INFO", "FULL_RESCAN started", { jobId });
  await repairParentPaths();
  const liveTemps = await journalTemps();
  await setStatus("scanner_status", "scanning");
  const stats: Stats = { dirsChecked: 0, filesChecked: 0, filesAdded: 0, filesChanged: 0, removed: 0, queued: 0, errors: 0 };
  const changedDirs = new Set<string>();
  let lastReport = Date.now();
  let cancelled = false;

  try {
    // ── Mount sanity check ──
    await access(MEDIA_ROOT, constants.R_OK);
    const top = (await readdir(MEDIA_ROOT)).filter((n) => !isIgnoredName(n));
    const indexed = await prisma.fileNode.count({ where: { inTrash: false } });
    if (top.length === 0 && indexed > 0) {
      throw new Error(
        "The media folder is empty but the index is not — the drive may not be mounted. Nothing was changed."
      );
    }

    await prisma.scanJob.update({ where: { id: jobId }, data: { status: "RUNNING", startedAt: new Date(), totalFiles: indexed } });

    const pending = new Set(
      (
        await prisma.scanJob.findMany({
          where: { type: "PROCESS_FILE", status: { in: ["PENDING", "RUNNING"] } },
          select: { fileNodeId: true },
        })
      ).map((j) => j.fileNodeId)
    );
    const toQueue: { id: string; relativePath: string; sourceVersion: string | null }[] = [];

    const flushQueue = async () => {
      if (toQueue.length === 0) return;
      const batch = toQueue.splice(0, toQueue.length);
      await prisma.scanJob.createMany({
        data: batch.map((n) => ({
          type: "PROCESS_FILE" as const,
          status: "PENDING" as const,
          fileNodeId: n.id,
          targetPath: n.relativePath,
          sourceVersion: n.sourceVersion,
        })),
      });
      stats.queued += batch.length;
      await prisma.$executeRaw`SELECT pg_notify('loom_jobs', 'wake')`.catch(() => {});
    };

    const queue = (n: { id: string; relativePath: string; sourceVersion: string | null }) => {
      if (pending.has(n.id)) return;
      pending.add(n.id);
      toQueue.push(n);
    };

    const checkProgress = async () => {
      if (Date.now() - lastReport < 2000) return;
      lastReport = Date.now();
      const job = await prisma.scanJob.findUnique({ where: { id: jobId }, select: { status: true } }).catch(() => null);
      if (job?.status === "CANCELLED") cancelled = true;
      await prisma.scanJob.update({ where: { id: jobId }, data: { processedFiles: stats.filesChecked } }).catch(() => {});
      await flushQueue();
    };

    const walk = async (dirRel: string): Promise<void> => {
      if (cancelled) return;
      const dirAbs = dirRel ? join(MEDIA_ROOT, dirRel) : MEDIA_ROOT;
      let entries: Dirent[];
      try {
        entries = await readdir(dirAbs, { withFileTypes: true });
      } catch (err) {
        stats.errors++;
        log("WARN", `Cannot read folder, skipping (nothing removed): ${dirRel || "/"}`, { error: String(err) });
        return;
      }
      stats.dirsChecked++;

      const existing = await prisma.fileNode.findMany({
        where: { parentPath: dirRel, inTrash: false },
        include: { contentIdentity: { include: { thumbnail: true, preview: true } } },
      });
      const byName = new Map(existing.map((n) => [n.name, n]));
      const seen = new Set<string>();
      const newRows: Prisma.FileNodeCreateManyInput[] = [];
      const subdirs: string[] = [];

      for (const entry of entries) {
        if (isLoomTempName(entry.name)) {
          await discardStaleTemp(join(dirAbs, entry.name), liveTemps);
          continue;
        }
        if (isIgnoredName(entry.name)) continue;
        // Symlinks are never followed: they could point outside the media folder.
        if (entry.isSymbolicLink()) continue;
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        const abs = join(dirAbs, entry.name);

        if (entry.isDirectory()) {
          seen.add(entry.name);
          const node = byName.get(entry.name);
          if (!node || node.type !== "DIRECTORY") {
            if (node) {
              await deleteSubtree(node.relativePath);
              stats.removed++;
            }
            const st = await stat(abs).catch(() => null);
            newRows.push({ relativePath: rel, parentPath: dirRel, name: entry.name, type: "DIRECTORY", modifiedAt: st?.mtime ?? null });
            changedDirs.add(dirRel);
          }
          subdirs.push(rel);
          continue;
        }
        if (!entry.isFile()) continue;

        seen.add(entry.name);
        stats.filesChecked++;
        let st;
        try {
          st = await stat(abs);
        } catch {
          continue;
        }
        const sv = sourceVersionOf(st.size, st.mtimeMs);
        const node = byName.get(entry.name);

        if (!node || node.type !== "FILE") {
          if (node) await deleteSubtree(node.relativePath);
          newRows.push({
            relativePath: rel,
            parentPath: dirRel,
            name: entry.name,
            type: "FILE",
            mimeType: mime.lookup(entry.name) || null,
            size: BigInt(st.size),
            modifiedAt: st.mtime,
            sourceVersion: sv,
          });
          stats.filesAdded++;
          changedDirs.add(dirRel);
          continue;
        }

        const unchanged = node.size === BigInt(st.size) && node.modifiedAt?.getTime() === st.mtime.getTime();
        if (!unchanged) {
          await prisma.fileNode.update({
            where: { id: node.id },
            data: {
              size: BigInt(st.size),
              modifiedAt: st.mtime,
              sourceVersion: sv,
              contentIdentityId: null,
              browserCompatible: null,
              healthStatus: "HEALTHY",
              healthError: null,
              healthCheckedVersion: null,
              mimeType: mime.lookup(entry.name) || null,
            },
          });
          stats.filesChanged++;
          changedDirs.add(dirRel);
          if (isProcessable(entry.name)) queue({ id: node.id, relativePath: rel, sourceVersion: sv });
          continue;
        }

        if (!node.sourceVersion) {
          await prisma.fileNode.update({ where: { id: node.id }, data: { sourceVersion: sv } }).catch(() => {});
        }

        // Unchanged: queue processing only if derived media is missing or outdated.
        if (isProcessable(entry.name) && node.healthStatus === "HEALTHY") {
          const ci = node.contentIdentity;
          const isImage = IMAGE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase());
          const thumbOk = !!ci?.thumbnail && ci.thumbnail.profileVersion === THUMB_PROFILE && (await cacheFileExists(ci.thumbnail.cachePath));
          const previewOk = !isImage || (!!ci?.preview && ci.preview.profileVersion === PREVIEW_PROFILE && (await cacheFileExists(ci.preview.cachePath)));
          if (!ci || !thumbOk || !previewOk || !ci.mediaInfo) queue({ id: node.id, relativePath: rel, sourceVersion: sv });
        }
        await checkProgress();
        if (cancelled) return;
      }

      if (newRows.length > 0) {
        for (let i = 0; i < newRows.length; i += 1000) {
          await prisma.fileNode.createMany({ data: newRows.slice(i, i + 1000), skipDuplicates: true });
        }
        const created = await prisma.fileNode.findMany({
          where: { parentPath: dirRel, inTrash: false, type: "FILE", relativePath: { in: newRows.filter((r) => r.type === "FILE").map((r) => r.relativePath) } },
          select: { id: true, relativePath: true, name: true, sourceVersion: true },
        });
        for (const n of created) if (isProcessable(n.name)) queue(n);
      }

      // Items indexed in this folder that are no longer on disk.
      for (const node of existing) {
        if (!seen.has(node.name)) {
          await deleteSubtree(node.relativePath);
          stats.removed++;
          changedDirs.add(dirRel);
        }
      }

      await checkProgress();
      for (const sub of subdirs) {
        if (cancelled) return;
        await walk(sub);
      }
    };

    await walk("");
    await flushQueue();

    if (cancelled) {
      log("INFO", `FULL_RESCAN ${jobId} cancelled`, stats);
      await prisma.scanJob.update({ where: { id: jobId }, data: { completedAt: new Date(), processedFiles: stats.filesChecked } });
      return;
    }

    const trashExpired = await expireTrash();
    const gc = await runOrphanGC();
    const orphanTrash = await sweepOrphanTrash();

    log("INFO", "FULL_RESCAN completed", { ...stats, trashExpired, gc, orphanTrash });
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "COMPLETED", completedAt: new Date(), processedFiles: stats.filesChecked, totalFiles: stats.filesChecked },
    });
  } catch (err) {
    log("ERROR", "FULL_RESCAN failed", { error: String(err) });
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "FAILED", completedAt: new Date(), error: String((err as Error)?.message ?? err).slice(0, 2000) },
    });
  } finally {
    await setStatus("scanner_status", "idle");
    const dirs = [...changedDirs];
    await publishChange(dirs.length > 40 ? ["*"] : dirs.length ? dirs : ["*"]);
  }
}

async function deleteSubtree(rel: string) {
  const pattern = likePrefix(rel);
  await prisma.$executeRaw`DELETE FROM "file_nodes" WHERE "inTrash" = false AND ("relativePath" = ${rel} OR "relativePath" LIKE ${pattern} ESCAPE '\\')`;
}
