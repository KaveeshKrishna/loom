import { PrismaClient } from "@prisma/client";
import { readdir, stat, access, mkdir, writeFile } from "fs/promises";
import { join, relative, extname, basename } from "path";
import sharp from "sharp";
import mime from "mime-types";
import { constants } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";

const execAsync = promisify(exec);
const prisma = new PrismaClient();

const MEDIA_ROOT = "/media";
const CACHE_ROOT = "/cache";
const THUMB_DIR = join(CACHE_ROOT, "thumbnails");
const PREVIEW_DIR = join(CACHE_ROOT, "previews");
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
  // Upload pipeline staging dir — files here are mid-transfer, not complete
  ".tmp-upload",
]);

// File extensions for which we generate thumbnails/previews
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

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
// Cache helpers (write to NVMe /cache only — never reads from T7 if cached)
// ---------------------------------------------------------------------------

async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}

// Returns relative cache path like "thumbnails/<hash>.webp", or null on permanent failure.
//
// Fast-path order (all on NVMe — never touches /media):
//   1. .webp exists → return it immediately
//   2. .failed sentinel exists → a previous attempt failed; skip permanently
//   3. Neither → open the file from /media and attempt generation
//
// On any generation error a zero-byte .failed sentinel is written to NVMe.
// All future scans will hit fast-path #2 and skip the file without ever
// opening it from the SSD, preventing stale mmaps from keeping the T7 awake.
async function generateThumbnail(absolutePath: string, relativePath: string): Promise<string | null> {
  const hash = createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  const thumbPath    = join(THUMB_DIR, `${hash}.webp`);
  const failedPath   = join(THUMB_DIR, `${hash}.failed`);
  const thumbRelative = `thumbnails/${hash}.webp`;

  // Fast-path 1: thumbnail already cached on NVMe
  try { await access(thumbPath, constants.R_OK); return thumbRelative; } catch {}
  // Fast-path 2: previously failed — skip without touching SSD
  try { await access(failedPath, constants.F_OK); return null; } catch {}

  try {
    await ensureDir(THUMB_DIR);
    await sharp(absolutePath)
      .resize(320, 320, { fit: "cover", position: "centre" })
      .webp({ quality: 75 })
      .toFile(thumbPath);
    return thumbRelative;
  } catch (err) {
    log("WARN", `Thumbnail failed for ${relativePath} — writing sentinel to skip on future scans`, { error: String(err) });
    // Sentinel: zero-byte marker so this file is never opened from SSD again
    await writeFile(failedPath, "").catch(() => {});
    return null;
  }
}

async function generatePreview(absolutePath: string, relativePath: string): Promise<string | null> {
  const hash = createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  const previewPath    = join(PREVIEW_DIR, `${hash}.webp`);
  const failedPath     = join(PREVIEW_DIR, `${hash}.failed`);
  const previewRelative = `previews/${hash}.webp`;

  // Fast-path 1: preview already cached on NVMe
  try { await access(previewPath, constants.R_OK); return previewRelative; } catch {}
  // Fast-path 2: previously failed — skip without touching SSD
  try { await access(failedPath, constants.F_OK); return null; } catch {}

  try {
    await ensureDir(PREVIEW_DIR);
    await sharp(absolutePath)
      .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(previewPath);
    return previewRelative;
  } catch (err) {
    log("WARN", `Preview failed for ${relativePath} — writing sentinel to skip on future scans`, { error: String(err) });
    await writeFile(failedPath, "").catch(() => {});
    return null;
  }
}

async function generateVideoThumbnail(absolutePath: string, relativePath: string): Promise<string | null> {
  const hash = createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  const posterPath     = join(PREVIEW_DIR, `video-${hash}.webp`);
  const failedPath     = join(PREVIEW_DIR, `video-${hash}.failed`);
  const posterRelative = `previews/video-${hash}.webp`;

  // Fast-path 1: poster already cached on NVMe
  try { await access(posterPath, constants.R_OK); return posterRelative; } catch {}
  // Fast-path 2: previously failed — skip without touching SSD
  try { await access(failedPath, constants.F_OK); return null; } catch {}

  try {
    await ensureDir(PREVIEW_DIR);
    await execAsync(
      `ffmpeg -y -ss 1 -i "${absolutePath}" -frames:v 1 -vf "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease" -c:v libwebp -quality 75 "${posterPath}"`
    );
    return posterRelative;
  } catch (err) {
    log("WARN", `Video thumbnail failed for ${relativePath} — writing sentinel to skip on future scans`, { error: String(err) });
    await writeFile(failedPath, "").catch(() => {});
    return null;
  }
}

// ---------------------------------------------------------------------------
// File / directory indexing
// ---------------------------------------------------------------------------

// Indexes one file.  Uses size + mtime for change detection — no SHA-256 full
// file read.  Only reads from T7 if thumbnail/preview cache needs generating.
async function processFile(absolutePath: string, fileStatObj?: Awaited<ReturnType<typeof stat>>) {
  const name = basename(absolutePath);
  if (IGNORED_DIRS.has(name) || name.startsWith("._")) return;
  const relativePath = relative(MEDIA_ROOT, absolutePath);
  if (relativePath.includes("/.Trash") || relativePath.includes("/$RECYCLE.BIN")) return;

  try {
    const fileStat = fileStatObj ?? await stat(absolutePath);
    const ext = extname(name).toLowerCase();
    const mimeType = mime.lookup(name) || null;
    const modifiedAt = fileStat.mtime;

    const node = await prisma.fileNode.upsert({
      where: { relativePath },
      update: {
        name,
        mimeType: mimeType ?? undefined,
        size: BigInt(fileStat.size),
        modifiedAt,
        isVisible: true,
      },
      create: {
        relativePath,
        name,
        type: "FILE",
        mimeType: mimeType ?? undefined,
        size: BigInt(fileStat.size),
        modifiedAt,
        isVisible: true,
      },
    });

    if (IMAGE_EXTENSIONS.has(ext)) {
      const thumbPath = await generateThumbnail(absolutePath, relativePath);
      const previewPath = await generatePreview(absolutePath, relativePath);
      if (thumbPath) {
        await prisma.thumbnail.upsert({
          where: { fileNodeId: node.id },
          update: { cachePath: thumbPath },
          create: { fileNodeId: node.id, cachePath: thumbPath, width: 320, height: 320 },
        });
      }
      if (previewPath) {
        // Read image metadata for dimensions — only needed when creating a new preview
        const existing = await prisma.preview.findUnique({ where: { fileNodeId: node.id } });
        const width = existing?.width ?? (await sharp(absolutePath).metadata().catch(() => ({}))).width ?? 0;
        const height = existing?.height ?? (await sharp(absolutePath).metadata().catch(() => ({}))).height ?? 0;
        await prisma.preview.upsert({
          where: { fileNodeId: node.id },
          update: { cachePath: previewPath },
          create: { fileNodeId: node.id, cachePath: previewPath, width, height },
        });
      }
    } else if (VIDEO_EXTENSIONS.has(ext)) {
      const posterPath = await generateVideoThumbnail(absolutePath, relativePath);
      if (posterPath) {
        await prisma.thumbnail.upsert({
          where: { fileNodeId: node.id },
          update: { cachePath: posterPath },
          create: { fileNodeId: node.id, cachePath: posterPath, width: 320, height: 320 },
        });
      }
    }
  } catch (err) {
    log("WARN", `Failed to process file: ${relative(MEDIA_ROOT, absolutePath)}`, { error: String(err) });
  }
}

async function processDirectory(absolutePath: string) {
  const name = basename(absolutePath);
  if (IGNORED_DIRS.has(name) || name.startsWith("._")) return;
  const relativePath = relative(MEDIA_ROOT, absolutePath);
  if (!relativePath) return; // root

  try {
    await prisma.fileNode.upsert({
      where: { relativePath },
      update: { name, isVisible: true },
      create: { relativePath, name, type: "DIRECTORY", isVisible: true },
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

async function scanDirectory(
  dirPath: string,
  jobId: string
): Promise<number> {
  let count = 0;
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

        // Change detection: size + mtime only (no SHA-256 full-file read)
        const existing = await prisma.fileNode.findUnique({
          where: { relativePath: relPath },
          include: { thumbnail: true, preview: true },
        });

        const unchanged =
          existing &&
          existing.size === BigInt(fileStat.size) &&
          existing.modifiedAt?.getTime() === fileStat.mtime.getTime();

        if (unchanged) {
          // Metadata unchanged. Only generate cache if genuinely missing —
          // generateThumbnail/Preview return early from NVMe access() check
          // without touching the T7 when the cache file already exists.
          if (IMAGE_EXTENSIONS.has(ext)) {
            if (!existing.thumbnail) {
              const thumbPath = await generateThumbnail(absolutePath, relPath);
              if (thumbPath && existing.id) {
                await prisma.thumbnail.upsert({
                  where: { fileNodeId: existing.id },
                  update: { cachePath: thumbPath },
                  create: { fileNodeId: existing.id, cachePath: thumbPath, width: 320, height: 320 },
                }).catch(() => {});
              }
            }
            if (!existing.preview) {
              const previewPath = await generatePreview(absolutePath, relPath);
              if (previewPath && existing.id) {
                const imgMeta = await sharp(absolutePath).metadata().catch(() => ({ width: 0, height: 0 }));
                await prisma.preview.upsert({
                  where: { fileNodeId: existing.id },
                  update: { cachePath: previewPath },
                  create: { fileNodeId: existing.id, cachePath: previewPath, width: imgMeta.width ?? 0, height: imgMeta.height ?? 0 },
                }).catch(() => {});
              }
            }
          } else if (VIDEO_EXTENSIONS.has(ext) && !existing.thumbnail) {
            const posterPath = await generateVideoThumbnail(absolutePath, relPath);
            if (posterPath && existing.id) {
              await prisma.thumbnail.upsert({
                where: { fileNodeId: existing.id },
                update: { cachePath: posterPath },
                create: { fileNodeId: existing.id, cachePath: posterPath, width: 320, height: 320 },
              }).catch(() => {});
            }
          }
        } else {
          // New or changed file — full index
          await processFile(absolutePath, fileStat);
        }

        count++;

        // Progress + cancellation check every 2 s
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
            .update({ where: { id: jobId }, data: { processedFiles: count } })
            .catch(() => {});
        }
      }
    }
  }

  await walk(dirPath);
  return count;
}

async function pruneDeletedFiles() {
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
}

async function runFullRescan(jobId: string) {
  log("INFO", "Starting FULL_RESCAN", { jobId });
  await updateScannerStatus("scanning");

  try {
    const totalFiles = await countFiles(MEDIA_ROOT);
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "RUNNING", startedAt: new Date(), totalFiles },
    });

    const count = await scanDirectory(MEDIA_ROOT, jobId);
    await pruneDeletedFiles();

    log("INFO", "FULL_RESCAN completed", { filesProcessed: count });
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "COMPLETED", completedAt: new Date(), processedFiles: totalFiles || count },
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
// Atomic upload pipeline guarantee: the file MUST already be confirmed on the
// T7 before this job is created.  If the file is missing, the job is FAILED —
// no DB records or cache files are created for it.
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

    // Defensive check: file must actually exist on the T7.
    // If it doesn't (upload pipeline failure), we fail the job immediately.
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
    // Unknown job type — should not happen; mark FAILED so it doesn't block
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
  await ensureDir(TEMP_DIR);

  // On startup, do NOT scan automatically. The SSD must be left completely
  // idle so the OS USB runtime PM can suspend it.
  // The Owner triggers scans explicitly via Settings → Scanner → Rescan Library.

  while (true) {
    try {
      await checkForPendingJobs();
    } catch (err) {
      log("ERROR", "Job loop error", { error: String(err) });
    }
    // Poll DB for new jobs every 10 seconds — zero SSD activity between jobs
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
