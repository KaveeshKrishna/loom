import { PrismaClient } from "@prisma/client";
import { readdir, stat, access, mkdir, writeFile, unlink, rm, rename } from "fs/promises";
import { join, relative, extname, basename, dirname } from "path";
import sharp from "sharp";
import mime from "mime-types";
import { constants } from "fs";
import { spawn } from "child_process";
import { createHash } from "crypto";

const prisma = new PrismaClient();

const MEDIA_ROOT = "/media";
const CACHE_ROOT = "/cache";
const THUMB_DIR = join(CACHE_ROOT, "thumbnails");
const PREVIEW_DIR = join(CACHE_ROOT, "previews");
const VIDEO_CACHE_DIR = join(CACHE_ROOT, "videos");
const TEMP_DIR = join(CACHE_ROOT, "temp");

// Directories to permanently ignore — OS metadata and upload staging
const IGNORED_DIRS = new Set([
  "$RECYCLE.BIN",
  "System Volume Information",
  ".Trashes",
  ".Spotlight-V100",
  ".fseventsd",
  ".TemporaryItems",
  ".DS_Store",
  "RECYCLER",
  "FOUND.000",
  ".tmp-upload",
]);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif", ".avif", ".thm", ".thim"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".mpg", ".mpeg"]);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: "INFO" | "WARN" | "ERROR", msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] [${level}] ${msg}`;
  if (data) console.log(entry, JSON.stringify(data));
  else console.log(entry);
}

// ---------------------------------------------------------------------------
// Source Version
// ---------------------------------------------------------------------------

function computeSourceVersion(size: number, mtimeMs: number): string {
  return `${size}-${mtimeMs}`;
}

// ---------------------------------------------------------------------------
// Scanner status
// ---------------------------------------------------------------------------

async function updateScannerStatus(status: string) {
  await prisma.systemStatus.upsert({
    where: { key: "scanner_status" },
    update: { value: status },
    create: { key: "scanner_status", value: status },
  });
}

// ---------------------------------------------------------------------------
// Cache helpers — NVMe only, never touches T7 unless cache is missing
// ---------------------------------------------------------------------------

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

// Cache key for image thumbnails/previews: {fileNodeId}_{sourceVersion}
// This is path-independent — moves/renames do not invalidate the cache.
function thumbCachePath(fileNodeId: string, sourceVersion: string): string {
  return `thumbnails/${fileNodeId}_${sourceVersion}.webp`;
}
function previewCachePath(fileNodeId: string, sourceVersion: string): string {
  return `previews/${fileNodeId}_${sourceVersion}.webp`;
}
function videoThumbCachePath(fileNodeId: string, sourceVersion: string): string {
  return `previews/video-${fileNodeId}_${sourceVersion}.webp`;
}

// Returns relative cache path or null on permanent failure.
// Checks .failed sentinel so permanently broken files are never retried.
async function generateThumbnail(
  absolutePath: string,
  fileNodeId: string,
  sourceVersion: string,
  forceRetryFailed: boolean = false
): Promise<string | null> {
  const relPath = thumbCachePath(fileNodeId, sourceVersion);
  const thumbPath = join(CACHE_ROOT, relPath);
  const failedPath = thumbPath.replace(".webp", ".failed");

  try { await access(thumbPath, constants.R_OK); return relPath; } catch {}
  if (!forceRetryFailed) {
    try { await access(failedPath, constants.F_OK); return null; } catch {}
  } else {
    await unlink(failedPath).catch(() => {});
  }

  try {
    await ensureDir(THUMB_DIR);
    await sharp(absolutePath)
      .resize(320, 320, { fit: "cover", position: "centre" })
      .webp({ quality: 75 })
      .toFile(thumbPath);
    return relPath;
  } catch (err) {
    log("WARN", `Thumbnail failed for ${fileNodeId} — writing sentinel`, { error: String(err) });
    await writeFile(failedPath, "").catch(() => {});
    return null;
  }
}

async function generatePreview(
  absolutePath: string,
  fileNodeId: string,
  sourceVersion: string,
  forceRetryFailed: boolean = false
): Promise<string | null> {
  const relPath = previewCachePath(fileNodeId, sourceVersion);
  const previewPath = join(CACHE_ROOT, relPath);
  const failedPath = previewPath.replace(".webp", ".failed");

  try { await access(previewPath, constants.R_OK); return relPath; } catch {}
  if (!forceRetryFailed) {
    try { await access(failedPath, constants.F_OK); return null; } catch {}
  } else {
    await unlink(failedPath).catch(() => {});
  }

  try {
    await ensureDir(PREVIEW_DIR);
    await sharp(absolutePath)
      .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(previewPath);
    return relPath;
  } catch (err) {
    log("WARN", `Preview failed for ${fileNodeId} — writing sentinel`, { error: String(err) });
    await writeFile(failedPath, "").catch(() => {});
    return null;
  }
}

async function generateVideoThumbnail(
  absolutePath: string,
  fileNodeId: string,
  sourceVersion: string,
  forceRetryFailed: boolean = false
): Promise<string | null> {
  const relPath = videoThumbCachePath(fileNodeId, sourceVersion);
  const posterPath = join(CACHE_ROOT, relPath);
  const failedPath = posterPath.replace(".webp", ".failed");

  try { await access(posterPath, constants.R_OK); return relPath; } catch {}
  if (!forceRetryFailed) {
    try { await access(failedPath, constants.F_OK); return null; } catch {}
  } else {
    await unlink(failedPath).catch(() => {});
  }

  try {
    await ensureDir(PREVIEW_DIR);
    // Spawn with argument array — no shell interpolation/injection
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-y", "-ss", "1", "-i", absolutePath,
        "-frames:v", "1",
        "-vf", "scale=w=320:h=320:force_original_aspect_ratio=decrease",
        "-c:v", "libwebp", "-quality", "75",
        posterPath,
      ]);
      let errLog = "";
      proc.stderr.on("data", (d) => errLog += d.toString());
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${errLog}`)));
      proc.on("error", reject);
    });
    return relPath;
  } catch (err) {
    log("WARN", `Video thumbnail failed for ${fileNodeId} — writing sentinel`, { error: String(err) });
    await writeFile(failedPath, "").catch(() => {});
    return null;
  }
}

// ---------------------------------------------------------------------------
// Invalidate derived media for a changed file
// ---------------------------------------------------------------------------

async function invalidateDerivedMedia(fileNodeId: string, oldSourceVersion: string | null) {
  // Delete stale Thumbnail record and NVMe files
  const thumb = await prisma.thumbnail.findUnique({ where: { fileNodeId } });
  if (thumb) {
    await prisma.thumbnail.delete({ where: { fileNodeId } }).catch(() => {});
    const absPath = join(CACHE_ROOT, thumb.cachePath);
    await unlink(absPath).catch(() => {});
    await unlink(absPath.replace(".webp", ".failed")).catch(() => {});
  }

  // Delete stale Preview record and NVMe files
  const preview = await prisma.preview.findUnique({ where: { fileNodeId } });
  if (preview) {
    await prisma.preview.delete({ where: { fileNodeId } }).catch(() => {});
    const absPath = join(CACHE_ROOT, preview.cachePath);
    await unlink(absPath).catch(() => {});
    await unlink(absPath.replace(".webp", ".failed")).catch(() => {});
  }

  // Delete stale VideoCache records for old sourceVersion — NVMe cleanup handled by GC phase
  if (oldSourceVersion) {
    await prisma.videoCache.deleteMany({
      where: { fileNodeId, sourceVersion: oldSourceVersion },
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// File / directory indexing
// ---------------------------------------------------------------------------

async function processFile(
  absolutePath: string,
  fileStatObj?: Awaited<ReturnType<typeof stat>>
) {
  const name = basename(absolutePath);
  if (IGNORED_DIRS.has(name) || name.startsWith("._")) return;
  const relativePath = relative(MEDIA_ROOT, absolutePath);
  if (relativePath.includes("/.Trash") || relativePath.includes("/$RECYCLE.BIN")) return;

  try {
    const fileStat = fileStatObj ?? await stat(absolutePath);
    const ext = extname(name).toLowerCase();
    const mimeType = mime.lookup(name) || null;
    const modifiedAt = fileStat.mtime;
    const sourceVersion = computeSourceVersion(fileStat.size, fileStat.mtimeMs);

    const node = await prisma.fileNode.upsert({
      where: { relativePath },
      update: {
        name,
        mimeType: mimeType ?? undefined,
        size: BigInt(fileStat.size),
        modifiedAt,
        sourceVersion,
        isVisible: true,
      },
      create: {
        relativePath,
        name,
        type: "FILE",
        mimeType: mimeType ?? undefined,
        size: BigInt(fileStat.size),
        modifiedAt,
        sourceVersion,
        isVisible: true,
      },
    });

    if (IMAGE_EXTENSIONS.has(ext)) {
      const thumbPath = await generateThumbnail(absolutePath, node.id, sourceVersion);
      const previewPath = await generatePreview(absolutePath, node.id, sourceVersion);
      if (thumbPath) {
        await prisma.thumbnail.upsert({
          where: { fileNodeId: node.id },
          update: { cachePath: thumbPath, sourceVersion },
          create: { fileNodeId: node.id, cachePath: thumbPath, width: 320, height: 320, sourceVersion },
        });
      }
      if (previewPath) {
        const existing = await prisma.preview.findUnique({ where: { fileNodeId: node.id } });
        const width = existing?.width ?? (await sharp(absolutePath).metadata().catch(() => ({}))).width ?? 0;
        const height = existing?.height ?? (await sharp(absolutePath).metadata().catch(() => ({}))).height ?? 0;
        await prisma.preview.upsert({
          where: { fileNodeId: node.id },
          update: { cachePath: previewPath, sourceVersion },
          create: { fileNodeId: node.id, cachePath: previewPath, width, height, sourceVersion },
        });
      }
    } else if (VIDEO_EXTENSIONS.has(ext)) {
      const posterPath = await generateVideoThumbnail(absolutePath, node.id, sourceVersion);
      if (posterPath) {
        await prisma.thumbnail.upsert({
          where: { fileNodeId: node.id },
          update: { cachePath: posterPath, sourceVersion },
          create: { fileNodeId: node.id, cachePath: posterPath, width: 320, height: 320, sourceVersion },
        });
      }
    }
  } catch (err) {
    log("WARN", `Failed to process file: ${relativePath}`, { error: String(err) });
  }
}

async function processDirectory(absolutePath: string) {
  const name = basename(absolutePath);
  if (IGNORED_DIRS.has(name) || name.startsWith("._")) return;
  const relativePath = relative(MEDIA_ROOT, absolutePath);
  if (!relativePath) return;

  try {
    const dirStat = await stat(absolutePath);
    await prisma.fileNode.upsert({
      where: { relativePath },
      update: { name, isVisible: true, modifiedAt: dirStat.mtime },
      create: { relativePath, name, type: "DIRECTORY", isVisible: true, modifiedAt: dirStat.mtime },
    });
  } catch (err) {
    log("WARN", `Failed to process dir: ${relativePath}`, { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// FULL_RESCAN: walk /media, index everything, prune deleted
// ---------------------------------------------------------------------------

async function countFiles(dirPath: string): Promise<number> {
  let count = 0;
  async function walk(currentPath: string) {
    try {
      const entries = await readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("._")) continue;
        if (entry.isDirectory()) await walk(join(currentPath, entry.name));
        else if (entry.isFile()) count++;
      }
    } catch { return; }
  }
  await walk(dirPath);
  return count;
}

// Reconciliation counters reported in job logs
interface RescanStats {
  filesChecked: number;
  filesAdded: number;
  filesChanged: number;
  filesRemoved: number;
  thumbsReused: number;
  thumbsRegenerated: number;
  thumbsMissing: number;
  previewsReused: number;
  previewsRegenerated: number;
  previewsMissing: number;
  videoCachesValid: number;
  videoCachesInvalidated: number;
  videoCachesOrphaned: number;
}

async function scanDirectory(dirPath: string, jobId: string): Promise<RescanStats> {
  const stats: RescanStats = {
    filesChecked: 0, filesAdded: 0, filesChanged: 0, filesRemoved: 0,
    thumbsReused: 0, thumbsRegenerated: 0, thumbsMissing: 0,
    previewsReused: 0, previewsRegenerated: 0, previewsMissing: 0,
    videoCachesValid: 0, videoCachesInvalidated: 0, videoCachesOrphaned: 0,
  };
  let lastReportTime = Date.now();

  async function walk(currentPath: string) {
    let entries;
    try { entries = await readdir(currentPath, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("._")) continue;
      const absolutePath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        await processDirectory(absolutePath);
        await walk(absolutePath);
      } else if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        const relPath = relative(MEDIA_ROOT, absolutePath);
        const ext = extname(entry.name).toLowerCase();
        const newSourceVersion = computeSourceVersion(fileStat.size, fileStat.mtimeMs);

        const existing = await prisma.fileNode.findUnique({
          where: { relativePath: relPath },
          include: { thumbnail: true, preview: true },
        });

        stats.filesChecked++;

        const unchanged =
          existing &&
          existing.size === BigInt(fileStat.size) &&
          existing.modifiedAt?.getTime() === fileStat.mtime.getTime();

        if (unchanged && existing) {
          // ── File unchanged ── check that derived media is still valid ──
          const currentVersion = existing.sourceVersion ?? newSourceVersion;

          // Backfill sourceVersion if it was NULL (e.g. pre-migration records)
          if (!existing.sourceVersion) {
            await prisma.fileNode.update({
              where: { id: existing.id },
              data: { sourceVersion: newSourceVersion },
            }).catch(() => {});
          }

          // THUMBNAIL check
          const thumbValid =
            existing.thumbnail &&
            existing.thumbnail.sourceVersion === currentVersion &&
            await access(join(CACHE_ROOT, existing.thumbnail.cachePath), constants.R_OK).then(() => true).catch(() => false);

          if (thumbValid) {
            stats.thumbsReused++;
          } else if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
            // Invalidate stale record before regenerating
            if (existing.thumbnail && existing.thumbnail.sourceVersion !== currentVersion) {
              await invalidateDerivedMedia(existing.id, null); // only thumb/preview, not video
            }
            const generator = IMAGE_EXTENSIONS.has(ext)
              ? () => generateThumbnail(absolutePath, existing.id, currentVersion, true)
              : () => generateVideoThumbnail(absolutePath, existing.id, currentVersion, true);
            const thumbPath = await generator();
            if (thumbPath) {
              await prisma.thumbnail.upsert({
                where: { fileNodeId: existing.id },
                update: { cachePath: thumbPath, sourceVersion: currentVersion },
                create: { fileNodeId: existing.id, cachePath: thumbPath, width: 320, height: 320, sourceVersion: currentVersion },
              }).catch(() => {});
              stats.thumbsRegenerated++;
            } else {
              stats.thumbsMissing++;
            }
          }

          // PREVIEW check (images only)
          if (IMAGE_EXTENSIONS.has(ext)) {
            const previewValid =
              existing.preview &&
              existing.preview.sourceVersion === currentVersion &&
              await access(join(CACHE_ROOT, existing.preview.cachePath), constants.R_OK).then(() => true).catch(() => false);

            if (previewValid) {
              stats.previewsReused++;
            } else {
              const previewPath = await generatePreview(absolutePath, existing.id, currentVersion, true);
              if (previewPath) {
                const imgMeta = await sharp(absolutePath).metadata().catch(() => ({ width: 0, height: 0 }));
                await prisma.preview.upsert({
                  where: { fileNodeId: existing.id },
                  update: { cachePath: previewPath, sourceVersion: currentVersion },
                  create: { fileNodeId: existing.id, cachePath: previewPath, width: imgMeta.width ?? 0, height: imgMeta.height ?? 0, sourceVersion: currentVersion },
                }).catch(() => {});
                stats.previewsRegenerated++;
              } else {
                stats.previewsMissing++;
              }
            }
          }

          // VIDEOCACHE check
          if (VIDEO_EXTENSIONS.has(ext)) {
            const videoCache = await prisma.videoCache.findFirst({
              where: { fileNodeId: existing.id, sourceVersion: currentVersion },
            });
            if (videoCache) {
              const cacheDirAbs = join(CACHE_ROOT, videoCache.cacheDir);
              const cacheExists = await access(cacheDirAbs, constants.R_OK).then(() => true).catch(() => false);
              if (cacheExists) {
                stats.videoCachesValid++;
              } else {
                // Cache dir missing — delete stale DB record; generation remains lazy
                await prisma.videoCache.delete({ where: { id: videoCache.id } }).catch(() => {});
                stats.videoCachesInvalidated++;
              }
            }
          }
        } else {
          // ── New or changed file ── invalidate old derived media, re-index ──
          if (existing) {
            stats.filesChanged++;
            const oldVersion = existing.sourceVersion;
            await invalidateDerivedMedia(existing.id, oldVersion);
          } else {
            stats.filesAdded++;
          }
          await processFile(absolutePath, fileStat);
          // Count newly generated thumb/preview as regenerated
          if (IMAGE_EXTENSIONS.has(ext)) { stats.thumbsRegenerated++; stats.previewsRegenerated++; }
          else if (VIDEO_EXTENSIONS.has(ext)) { stats.thumbsRegenerated++; }
        }

        // Progress + cancellation check every 2s
        if (Date.now() - lastReportTime > 2000) {
          lastReportTime = Date.now();
          const currentJob = await prisma.scanJob
            .findUnique({ where: { id: jobId }, select: { status: true } })
            .catch(() => null);
          if (currentJob?.status === "CANCELLED") {
            log("INFO", `Scan ${jobId} was cancelled by user`);
            return;
          }
          await prisma.scanJob
            .update({ where: { id: jobId }, data: { processedFiles: stats.filesChecked } })
            .catch(() => {});
        }
      }
    }
  }

  await walk(dirPath);
  return stats;
}

// ---------------------------------------------------------------------------
// Prune deleted FileNodes (with T7 mount sanity check)
// ---------------------------------------------------------------------------

async function pruneDeletedFiles(): Promise<number> {
  // Sanity check: verify /media is actually accessible before pruning anything
  try {
    await access(MEDIA_ROOT, constants.R_OK);
  } catch {
    log("WARN", "MEDIA_ROOT inaccessible — skipping prune to avoid false deletions (T7 may be temporarily unavailable)");
    return 0;
  }

  // Count accessible files to detect suspiciously low counts (possible mount failure)
  const indexedCount = await prisma.fileNode.count({ where: { type: "FILE" } });
  const accessibleCount = await countFiles(MEDIA_ROOT);
  if (indexedCount > 50 && accessibleCount < indexedCount * 0.1) {
    log("WARN", `Suspiciously low file count (${accessibleCount} vs ${indexedCount} indexed) — skipping prune (possible mount issue)`);
    return 0;
  }

  const allNodes = await prisma.fileNode.findMany({ select: { id: true, relativePath: true } });
  let pruned = 0;
  for (const node of allNodes) {
    try { await access(join(MEDIA_ROOT, node.relativePath), constants.F_OK); }
    catch {
      await prisma.fileNode.delete({ where: { id: node.id } });
      pruned++;
    }
  }
  if (pruned > 0) log("INFO", `Pruned ${pruned} deleted nodes from index`);
  return pruned;
}

// ---------------------------------------------------------------------------
// Orphan GC: clean up NVMe cache files that have no valid DB record
// ---------------------------------------------------------------------------

async function runOrphanGC(): Promise<{ thumbsDeleted: number; previewsDeleted: number; videoCachesDeleted: number }> {
  const result = { thumbsDeleted: 0, previewsDeleted: 0, videoCachesDeleted: 0 };

  // Build sets of valid cache paths
  const validThumbs = new Set<string>();
  const validPreviews = new Set<string>();
  const validVideoCacheDirs = new Set<string>();

  const thumbs = await prisma.thumbnail.findMany({ select: { cachePath: true } });
  thumbs.forEach(t => validThumbs.add(join(CACHE_ROOT, t.cachePath)));

  const previews = await prisma.preview.findMany({ select: { cachePath: true } });
  previews.forEach(p => validPreviews.add(join(CACHE_ROOT, p.cachePath)));

  const videoCaches = await prisma.videoCache.findMany({ select: { cacheDir: true } });
  videoCaches.forEach(v => validVideoCacheDirs.add(join(CACHE_ROOT, v.cacheDir)));

  // Clean orphaned thumbnails
  try {
    const thumbFiles = await readdir(THUMB_DIR);
    for (const f of thumbFiles) {
      const abs = join(THUMB_DIR, f);
      if (!validThumbs.has(abs) && !abs.endsWith(".failed")) {
        await unlink(abs).catch(() => {});
        result.thumbsDeleted++;
      }
    }
  } catch {}

  // Clean orphaned previews
  try {
    const previewFiles = await readdir(PREVIEW_DIR);
    for (const f of previewFiles) {
      const abs = join(PREVIEW_DIR, f);
      if (!validPreviews.has(abs) && !validThumbs.has(abs) && !abs.endsWith(".failed")) {
        await unlink(abs).catch(() => {});
        result.previewsDeleted++;
      }
    }
  } catch {}

  // Clean orphaned video cache directories
  try {
    await ensureDir(VIDEO_CACHE_DIR);
    const nodeIds = await readdir(VIDEO_CACHE_DIR);
    for (const nodeId of nodeIds) {
      const nodeDir = join(VIDEO_CACHE_DIR, nodeId);
      const versions = await readdir(nodeDir).catch(() => [] as string[]);
      for (const version of versions) {
        const versionDir = join(nodeDir, version);
        const cacheRelDir = `videos/${nodeId}/${version}`;
        if (!validVideoCacheDirs.has(join(CACHE_ROOT, cacheRelDir))) {
          await rm(versionDir, { recursive: true, force: true }).catch(() => {});
          result.videoCachesDeleted++;
        }
      }
      // If nodeId dir is now empty, remove it
      const remaining = await readdir(nodeDir).catch(() => ["placeholder"]);
      if (remaining.length === 0) await rm(nodeDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch {}

  return result;
}

// ---------------------------------------------------------------------------
// FULL_RESCAN orchestration
// ---------------------------------------------------------------------------

async function runFullRescan(jobId: string) {
  log("INFO", "Starting FULL_RESCAN", { jobId });
  await updateScannerStatus("scanning");

  try {
    const totalFiles = await countFiles(MEDIA_ROOT);
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "RUNNING", startedAt: new Date(), totalFiles },
    });

    // Phase 1: Walk /media, reconcile all files and their derived media
    const stats = await scanDirectory(MEDIA_ROOT, jobId);

    // Phase 2: Prune deleted FileNodes (with T7 safety check)
    stats.filesRemoved = await pruneDeletedFiles();

    // Phase 3: Orphan GC — clean stale/orphaned NVMe cache files
    const gcResult = await runOrphanGC();
    stats.videoCachesOrphaned = gcResult.videoCachesDeleted;

    log("INFO", "FULL_RESCAN completed", {
      filesChecked: stats.filesChecked,
      filesAdded: stats.filesAdded,
      filesChanged: stats.filesChanged,
      filesRemoved: stats.filesRemoved,
      thumbnails: { reused: stats.thumbsReused, regenerated: stats.thumbsRegenerated, missing: stats.thumbsMissing },
      previews: { reused: stats.previewsReused, regenerated: stats.previewsRegenerated, missing: stats.previewsMissing },
      videoCaches: { valid: stats.videoCachesValid, invalidated: stats.videoCachesInvalidated, orphaned: stats.videoCachesOrphaned },
      orphanedThumbs: gcResult.thumbsDeleted,
      orphanedPreviews: gcResult.previewsDeleted,
    });

    await prisma.scanJob.update({
      where: { id: jobId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        processedFiles: totalFiles || stats.filesChecked,
      },
    });
  } catch (err) {
    log("ERROR", "FULL_RESCAN failed", { error: String(err) });
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "FAILED", completedAt: new Date(), error: String(err) },
    });
  } finally {
    await updateScannerStatus("idle");
  }
}

// ---------------------------------------------------------------------------
// INDEX_FILE: index exactly one file (used after internal uploads)
// ---------------------------------------------------------------------------

async function runIndexFile(jobId: string, targetPath: string) {
  log("INFO", `Starting INDEX_FILE: ${targetPath}`, { jobId });
  await updateScannerStatus("indexing");

  try {
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "RUNNING", startedAt: new Date(), totalFiles: 1 },
    });

    const absolutePath = join(MEDIA_ROOT, targetPath);
    try {
      await access(absolutePath, constants.F_OK);
    } catch {
      throw new Error(`Target file does not exist on media: ${targetPath}`);
    }

    await processFile(absolutePath);

    log("INFO", `INDEX_FILE completed: ${targetPath}`, { jobId });
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "COMPLETED", completedAt: new Date(), processedFiles: 1 },
    });
  } catch (err) {
    log("ERROR", `INDEX_FILE failed: ${targetPath}`, { error: String(err) });
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "FAILED", completedAt: new Date(), error: String(err) },
    });
  } finally {
    await updateScannerStatus("idle");
  }
}

// ---------------------------------------------------------------------------
// Job polling loop
// ---------------------------------------------------------------------------

async function checkForPendingJobs() {
  const job = await prisma.scanJob.findFirst({
    where: { status: "PENDING" },
    orderBy: { requestedAt: "asc" },
  });
  if (!job) return;

  if (job.type === "FULL_RESCAN") {
    await runFullRescan(job.id);
  } else if (job.type === "INDEX_FILE") {
    if (!job.targetPath) {
      log("ERROR", `INDEX_FILE job ${job.id} has no targetPath — marking FAILED`);
      await prisma.scanJob.update({
        where: { id: job.id },
        data: { status: "FAILED", error: "Missing targetPath", completedAt: new Date() },
      });
    } else {
      await runIndexFile(job.id, job.targetPath);
    }
  } else {
    log("WARN", `Unknown job type: ${job.type} — marking FAILED`, { jobId: job.id });
    await prisma.scanJob.update({
      where: { id: job.id },
      data: { status: "FAILED", error: `Unknown job type: ${job.type}`, completedAt: new Date() },
    });
  }
}

// ---------------------------------------------------------------------------
// Startup & main loop
// ---------------------------------------------------------------------------

async function mainLoop() {
  log("INFO", "Loom Scanner started (DB-backed job queue — no filesystem watcher)");
  await ensureDir(THUMB_DIR);
  await ensureDir(PREVIEW_DIR);
  await ensureDir(VIDEO_CACHE_DIR);
  await ensureDir(TEMP_DIR);

  while (true) {
    try {
      await checkForPendingJobs();
    } catch (err) {
      log("ERROR", "Job loop error", { error: String(err) });
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

process.on("SIGTERM", async () => {
  log("INFO", "Scanner shutting down");
  await updateScannerStatus("idle");
  await prisma.$disconnect();
  process.exit(0);
});

mainLoop().catch(async (err) => {
  log("ERROR", "Fatal scanner error", { error: String(err) });
  await prisma.$disconnect();
  process.exit(1);
});
