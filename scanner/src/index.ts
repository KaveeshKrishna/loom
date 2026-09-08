import { PrismaClient } from "@prisma/client";
import { readdir, stat, access, mkdir, rm, rename } from "fs/promises";
import { join, relative, extname, basename } from "path";
import { createReadStream, constants } from "fs";
import type { Stats } from "fs";
import { createHash } from "crypto";
import sharp from "sharp";
import mime from "mime-types";
import { spawn } from "child_process";

const prisma = new PrismaClient();

const MEDIA_ROOT = "/media";
const CACHE_ROOT = "/cache";
const THUMB_DIR = join(CACHE_ROOT, "thumbnails");
const PREVIEW_DIR = join(CACHE_ROOT, "previews");
const VIDEO_CACHE_DIR = join(CACHE_ROOT, "videos");
const TEMP_DIR = join(CACHE_ROOT, "temp");

const THUMB_PROFILE = "v1";   // Bump when thumbnail generation params change
const PREVIEW_PROFILE = "v1"; // Bump when preview generation params change

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
  ".LoomTrash",
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
// NVMe dir helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// ContentIdentity — lazy hash, only computed when file is actually read
// ---------------------------------------------------------------------------

/**
 * Computes a fast hash of the file: SHA-256 of first 1MB + last 1MB.
 * This is NOT a full checksum but is sufficient for deduplication.
 * IMPORTANT: This reads from the physical disk. Only call when file is being read
 * for thumbnail/preview generation anyway — never during metadata-only scans.
 */
async function computeFastHash(absolutePath: string, fileSize: number): Promise<string> {
  const CHUNK = 1024 * 1024; // 1MB
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath, { start: 0, end: Math.min(CHUNK - 1, fileSize - 1) });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  if (fileSize > CHUNK) {
    const lastStart = Math.max(CHUNK, fileSize - CHUNK);
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absolutePath, { start: lastStart, end: fileSize - 1 });
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }

  return hash.digest("hex");
}

/**
 * Resolves or creates the ContentIdentity for a file being actively read.
 * This is called only when we are about to generate a thumbnail/preview.
 */
async function resolveContentIdentity(
  absolutePath: string,
  fileSize: number,
  fileNodeId: string
): Promise<string | null> {
  try {
    const fastHash = await computeFastHash(absolutePath, fileSize);
    const size = BigInt(fileSize);

    const identity = await prisma.contentIdentity.upsert({
      where: { size_fastHash: { size, fastHash } },
      update: {},
      create: { size, fastHash },
    });

    // Link the FileNode to this ContentIdentity
    await prisma.fileNode.update({
      where: { id: fileNodeId },
      data: { contentIdentityId: identity.id },
    });

    return identity.id;
  } catch (err) {
    log("WARN", `Could not resolve ContentIdentity for ${absolutePath}`, { error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache path helpers — keyed to ContentIdentity, never FileNode
// ---------------------------------------------------------------------------

function thumbCachePath(contentIdentityId: string): string {
  return `thumbnails/${contentIdentityId}_${THUMB_PROFILE}.webp`;
}

function previewCachePath(contentIdentityId: string): string {
  return `previews/${contentIdentityId}_${PREVIEW_PROFILE}.webp`;
}

function videoThumbCachePath(contentIdentityId: string): string {
  return `previews/video-${contentIdentityId}_${THUMB_PROFILE}.webp`;
}

// ---------------------------------------------------------------------------
// Thumbnail / Preview generation — ContentIdentity-keyed
// The "file is already read" invariant: by the time we call these, we've
// already computed the ContentIdentity (which required reading the file).
// ---------------------------------------------------------------------------

/**
 * Generates an image thumbnail and records it in the Thumbnail table.
 * Returns the cache relative path on success, null on failure.
 * Updates FileNode.healthStatus to CORRUPT if sharp fails irrecoverably.
 */
async function generateThumbnail(
  absolutePath: string,
  contentIdentityId: string,
  fileNodeId: string,
  forceRegenerate = false
): Promise<string | null> {
  const relPath = thumbCachePath(contentIdentityId);
  const thumbPath = join(CACHE_ROOT, relPath);

  // Check existing record at the ContentIdentity level
  const existing = await prisma.thumbnail.findUnique({ where: { contentIdentityId } });
  if (existing && existing.profileVersion === THUMB_PROFILE) {
    const onDisk = await access(thumbPath, constants.R_OK).then(() => true).catch(() => false);
    if (onDisk && !forceRegenerate) return relPath;
  }

  try {
    await ensureDir(THUMB_DIR);
    const meta = await sharp(absolutePath)
      .resize(320, 320, { fit: "cover", position: "centre" })
      .webp({ quality: 75 })
      .toFile(thumbPath);

    await prisma.thumbnail.upsert({
      where: { contentIdentityId },
      update: { cachePath: relPath, width: 320, height: 320, profileVersion: THUMB_PROFILE },
      create: { contentIdentityId, cachePath: relPath, width: 320, height: 320, profileVersion: THUMB_PROFILE },
    });

    // File is processable — mark HEALTHY (clear any previous error)
    await prisma.fileNode.update({
      where: { id: fileNodeId },
      data: { healthStatus: "HEALTHY", healthError: null, healthCheckedVersion: null },
    }).catch(() => {});

    return relPath;
  } catch (err: any) {
    log("WARN", `Thumbnail generation failed for ${absolutePath}`, { error: String(err) });
    // Distinguish unsupported format from corrupted file
    const isUnsupported = /unsupported|format|codec/i.test(String(err));
    await prisma.fileNode.update({
      where: { id: fileNodeId },
      data: {
        healthStatus: isUnsupported ? "UNSUPPORTED" : "CORRUPT",
        healthError: String(err).slice(0, 1000),
      },
    }).catch(() => {});
    return null;
  }
}

/**
 * Generates a full-resolution preview and records it in the Preview table.
 */
async function generatePreview(
  absolutePath: string,
  contentIdentityId: string,
  fileNodeId: string,
  forceRegenerate = false
): Promise<string | null> {
  const relPath = previewCachePath(contentIdentityId);
  const previewPath = join(CACHE_ROOT, relPath);

  const existing = await prisma.preview.findUnique({ where: { contentIdentityId } });
  if (existing && existing.profileVersion === PREVIEW_PROFILE) {
    const onDisk = await access(previewPath, constants.R_OK).then(() => true).catch(() => false);
    if (onDisk && !forceRegenerate) return relPath;
  }

  try {
    await ensureDir(PREVIEW_DIR);
    const imgMeta = await sharp(absolutePath).metadata();
    await sharp(absolutePath)
      .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(previewPath);

    await prisma.preview.upsert({
      where: { contentIdentityId },
      update: { cachePath: relPath, width: imgMeta.width, height: imgMeta.height, profileVersion: PREVIEW_PROFILE },
      create: { contentIdentityId, cachePath: relPath, width: imgMeta.width, height: imgMeta.height, profileVersion: PREVIEW_PROFILE },
    });

    return relPath;
  } catch (err: any) {
    log("WARN", `Preview generation failed for ${absolutePath}`, { error: String(err) });
    return null;
  }
}

/**
 * Generates a video thumbnail (poster frame) via ffmpeg.
 */
async function generateVideoThumbnail(
  absolutePath: string,
  contentIdentityId: string,
  fileNodeId: string,
  forceRegenerate = false
): Promise<string | null> {
  const relPath = videoThumbCachePath(contentIdentityId);
  const posterPath = join(CACHE_ROOT, relPath);

  const existing = await prisma.thumbnail.findUnique({ where: { contentIdentityId } });
  if (existing && existing.profileVersion === THUMB_PROFILE) {
    const onDisk = await access(posterPath, constants.R_OK).then(() => true).catch(() => false);
    if (onDisk && !forceRegenerate) return relPath;
  }

  try {
    await ensureDir(PREVIEW_DIR);
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

    await prisma.thumbnail.upsert({
      where: { contentIdentityId },
      update: { cachePath: relPath, width: 320, height: 320, profileVersion: THUMB_PROFILE },
      create: { contentIdentityId, cachePath: relPath, width: 320, height: 320, profileVersion: THUMB_PROFILE },
    });

    await prisma.fileNode.update({
      where: { id: fileNodeId },
      data: { healthStatus: "HEALTHY", healthError: null },
    }).catch(() => {});

    return relPath;
  } catch (err: any) {
    log("WARN", `Video thumbnail failed for ${absolutePath}`, { error: String(err) });
    const isUnsupported = /unsupported|codec|format/i.test(String(err));
    await prisma.fileNode.update({
      where: { id: fileNodeId },
      data: {
        healthStatus: isUnsupported ? "UNSUPPORTED" : "CORRUPT",
        healthError: String(err).slice(0, 1000),
      },
    }).catch(() => {});
    return null;
  }
}

// ---------------------------------------------------------------------------
// Invalidate derived media for a changed file
// When a file changes (sourceVersion mismatch), we must:
//   1. Clear the FileNode's contentIdentityId link (it may have new content)
//   2. Leave the ContentIdentity and its cached media alone — other FileNodes
//      might still reference the same content (e.g. duplicates).
//   3. The old ContentIdentity will be cleaned up by Orphan GC if nothing references it.
// ---------------------------------------------------------------------------

async function invalidateFileNodeCache(fileNodeId: string) {
  // Only clear the link — don't touch ContentIdentity or its derived media
  await prisma.fileNode.update({
    where: { id: fileNodeId },
    data: {
      contentIdentityId: null,
      healthStatus: "HEALTHY",
      healthError: null,
      healthCheckedVersion: null,
    },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// File / directory indexing
// ---------------------------------------------------------------------------

async function processFile(
  absolutePath: string,
  fileStatObj?: Stats
) {
  const name = basename(absolutePath);
  if (IGNORED_DIRS.has(name) || name.startsWith("._")) return;
  const relativePath = relative(MEDIA_ROOT, absolutePath);

  try {
    const fileStat = fileStatObj ?? await stat(absolutePath);
    const ext = extname(name).toLowerCase();
    const mimeType = mime.lookup(name) || null;
    const modifiedAt = fileStat.mtime;
    const sourceVersion = computeSourceVersion(fileStat.size, fileStat.mtimeMs);

    // Use findFirst + create/update since relativePath is not @unique
    const existing = await prisma.fileNode.findFirst({
      where: { relativePath, inTrash: false },
    });

    const node = existing
      ? await prisma.fileNode.update({
          where: { id: existing.id },
          data: {
            name,
            mimeType: mimeType ?? undefined,
            size: BigInt(fileStat.size),
            modifiedAt,
            sourceVersion,
            isVisible: true,
            inTrash: false,
          },
        })
      : await prisma.fileNode.create({
          data: {
            relativePath,
            name,
            type: "FILE",
            mimeType: mimeType ?? undefined,
            size: BigInt(fileStat.size),
            modifiedAt,
            sourceVersion,
            isVisible: true,
            inTrash: false,
          },
        });

    const isImage = IMAGE_EXTENSIONS.has(ext);
    const isVideo = VIDEO_EXTENSIONS.has(ext);

    if (isImage || isVideo) {
      // Lazy: resolve ContentIdentity only now that we're about to read the file
      const contentIdentityId = await resolveContentIdentity(absolutePath, fileStat.size, node.id);
      if (!contentIdentityId) return;

      if (isImage) {
        await generateThumbnail(absolutePath, contentIdentityId, node.id);
        await generatePreview(absolutePath, contentIdentityId, node.id);
      } else {
        await generateVideoThumbnail(absolutePath, contentIdentityId, node.id);
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
    const existing = await prisma.fileNode.findFirst({ where: { relativePath } });
    if (existing) {
      await prisma.fileNode.update({
        where: { id: existing.id },
        data: { name, isVisible: true, modifiedAt: dirStat.mtime },
      });
    } else {
      await prisma.fileNode.create({
        data: { relativePath, name, type: "DIRECTORY", isVisible: true, modifiedAt: dirStat.mtime },
      });
    }
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

        const existing = await prisma.fileNode.findFirst({
          where: { relativePath: relPath, inTrash: false },
          include: {
            contentIdentity: {
              include: { thumbnail: true, preview: true },
            },
          },
        });

        stats.filesChecked++;

        const unchanged =
          existing &&
          existing.size === BigInt(fileStat.size) &&
          existing.modifiedAt?.getTime() === fileStat.mtime.getTime();

        if (unchanged && existing) {
          // ── File unchanged ── verify derived media is still present ──
          // Backfill sourceVersion if NULL (pre-migration records)
          if (!existing.sourceVersion) {
            await prisma.fileNode.update({
              where: { id: existing.id },
              data: { sourceVersion: newSourceVersion },
            }).catch(() => {});
          }

          const ci = existing.contentIdentity;

          if (ci) {
            // Thumbnail check
            if (ci.thumbnail) {
              const onDisk = await access(join(CACHE_ROOT, ci.thumbnail.cachePath), constants.R_OK)
                .then(() => true).catch(() => false);
              if (onDisk && ci.thumbnail.profileVersion === THUMB_PROFILE) {
                stats.thumbsReused++;
              } else if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
                const path = isImage(ext)
                  ? await generateThumbnail(absolutePath, ci.id, existing.id, true)
                  : await generateVideoThumbnail(absolutePath, ci.id, existing.id, true);
                path ? stats.thumbsRegenerated++ : stats.thumbsMissing++;
              }
            } else if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
              // No thumbnail yet — generate
              const path = IMAGE_EXTENSIONS.has(ext)
                ? await generateThumbnail(absolutePath, ci.id, existing.id)
                : await generateVideoThumbnail(absolutePath, ci.id, existing.id);
              path ? stats.thumbsRegenerated++ : stats.thumbsMissing++;
            }

            // Preview check (images only)
            if (IMAGE_EXTENSIONS.has(ext)) {
              if (ci.preview) {
                const onDisk = await access(join(CACHE_ROOT, ci.preview.cachePath), constants.R_OK)
                  .then(() => true).catch(() => false);
                if (onDisk && ci.preview.profileVersion === PREVIEW_PROFILE) {
                  stats.previewsReused++;
                } else {
                  const path = await generatePreview(absolutePath, ci.id, existing.id, true);
                  path ? stats.previewsRegenerated++ : stats.previewsMissing++;
                }
              } else {
                const path = await generatePreview(absolutePath, ci.id, existing.id);
                path ? stats.previewsRegenerated++ : stats.previewsMissing++;
              }
            }

            // VideoCache check
            if (VIDEO_EXTENSIONS.has(ext)) {
              const videoCache = await prisma.videoCache.findFirst({
                where: { contentIdentityId: ci.id },
              });
              if (videoCache) {
                const cacheDirAbs = join(CACHE_ROOT, videoCache.cacheDir);
                const cacheExists = await access(cacheDirAbs, constants.R_OK).then(() => true).catch(() => false);
                if (cacheExists) {
                  stats.videoCachesValid++;
                } else {
                  await prisma.videoCache.delete({ where: { id: videoCache.id } }).catch(() => {});
                  stats.videoCachesInvalidated++;
                }
              }
            }
          } else if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
            // Unchanged file, no ContentIdentity yet — resolve lazily now
            const ciId = await resolveContentIdentity(absolutePath, fileStat.size, existing.id);
            if (ciId) {
              if (IMAGE_EXTENSIONS.has(ext)) {
                const tp = await generateThumbnail(absolutePath, ciId, existing.id);
                const pp = await generatePreview(absolutePath, ciId, existing.id);
                tp ? stats.thumbsRegenerated++ : stats.thumbsMissing++;
                pp ? stats.previewsRegenerated++ : stats.previewsMissing++;
              } else {
                const tp = await generateVideoThumbnail(absolutePath, ciId, existing.id);
                tp ? stats.thumbsRegenerated++ : stats.thumbsMissing++;
              }
            }
          }
        } else {
          // ── New or changed file ── invalidate old ContentIdentity link, re-index ──
          if (existing) {
            stats.filesChanged++;
            await invalidateFileNodeCache(existing.id);
          } else {
            stats.filesAdded++;
          }
          await processFile(absolutePath, fileStat);
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

function isImage(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Prune deleted FileNodes (with T7 mount sanity check)
// Skips inTrash nodes — they physically live in .LoomTrash, not relativePath
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
  const indexedCount = await prisma.fileNode.count({ where: { type: "FILE", inTrash: false } });
  const accessibleCount = await countFiles(MEDIA_ROOT);
  if (indexedCount > 50 && accessibleCount < indexedCount * 0.1) {
    log("WARN", `Suspiciously low file count (${accessibleCount} vs ${indexedCount} indexed) — skipping prune (possible mount issue)`);
    return 0;
  }

  // Only prune non-trashed nodes
  const allNodes = await prisma.fileNode.findMany({
    where: { inTrash: false },
    select: { id: true, relativePath: true },
  });
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
// Trash GC: Permanently delete expired trash items
// ---------------------------------------------------------------------------

async function expireTrashItems(): Promise<number> {
  log("INFO", "Starting Trash Expiration...");
  const expiredItems = await prisma.trashItem.findMany({
    where: { expiresAt: { lt: new Date() } },
    include: { fileNode: true },
  });

  let deleted = 0;
  for (const item of expiredItems) {
    const trashAbsPath = join(MEDIA_ROOT, ".LoomTrash", item.trashPath);
    try {
      await rm(trashAbsPath, { recursive: true, force: true });
      await prisma.fileNode.delete({ where: { id: item.fileNodeId } });
      await prisma.auditLog.create({
        data: {
          action: "EXPIRE_TRASH",
          details: { originalPath: item.originalPath, trashPath: item.trashPath },
        },
      });
      deleted++;
    } catch (err: any) {
      log("ERROR", `Failed to expire trash item ${item.trashPath}`, { error: err.message });
    }
  }

  log("INFO", "Trash Expiration complete", { deleted });
  return deleted;
}

// ---------------------------------------------------------------------------
// Orphan GC: clean up NVMe cache files with no valid DB record
// References ContentIdentity, not FileNode.
// A ContentIdentity is still needed if ANY non-deleted FileNode references it.
// ---------------------------------------------------------------------------

async function runOrphanGC(): Promise<{ thumbsDeleted: number; previewsDeleted: number; videoCachesDeleted: number }> {
  const result = { thumbsDeleted: 0, previewsDeleted: 0, videoCachesDeleted: 0 };

  // Build sets of valid cache paths from DB
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
        await import("fs/promises").then(m => m.unlink(abs)).catch(() => {});
        result.thumbsDeleted++;
      }
    }
  } catch {}

  // Clean orphaned previews (video posters live here too)
  try {
    const previewFiles = await readdir(PREVIEW_DIR);
    for (const f of previewFiles) {
      const abs = join(PREVIEW_DIR, f);
      if (!validPreviews.has(abs) && !validThumbs.has(abs) && !abs.endsWith(".failed")) {
        await import("fs/promises").then(m => m.unlink(abs)).catch(() => {});
        result.previewsDeleted++;
      }
    }
  } catch {}

  // Clean orphaned video cache directories
  try {
    await ensureDir(VIDEO_CACHE_DIR);
    const contentIds = await readdir(VIDEO_CACHE_DIR);
    for (const contentId of contentIds) {
      const contentDir = join(VIDEO_CACHE_DIR, contentId);
      const versions = await readdir(contentDir).catch(() => [] as string[]);
      for (const version of versions) {
        const versionDir = join(contentDir, version);
        const cacheRelDir = `videos/${contentId}/${version}`;
        if (!validVideoCacheDirs.has(join(CACHE_ROOT, cacheRelDir))) {
          await rm(versionDir, { recursive: true, force: true }).catch(() => {});
          result.videoCachesDeleted++;
        }
      }
      const remaining = await readdir(contentDir).catch(() => ["placeholder"]);
      if (remaining.length === 0) await rm(contentDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch {}

  // Also prune ContentIdentity records no longer referenced by any FileNode
  // This must run AFTER pruneDeletedFiles() to avoid removing identities of just-deleted nodes
  const orphanedIdentities = await prisma.contentIdentity.findMany({
    where: { nodes: { none: {} } },
    select: { id: true },
  });
  for (const ci of orphanedIdentities) {
    // Cascading delete removes Thumbnail/Preview/VideoCache automatically
    await prisma.contentIdentity.delete({ where: { id: ci.id } }).catch(() => {});
  }

  if (orphanedIdentities.length > 0) {
    log("INFO", `Pruned ${orphanedIdentities.length} orphaned ContentIdentity records`);
  }

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

    // Phase 3: Expire old Trash items before Orphan GC
    const trashExpired = await expireTrashItems();

    // Phase 4: Orphan GC — clean stale/orphaned NVMe cache files
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
      trashExpired,
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
