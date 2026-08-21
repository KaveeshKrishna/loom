import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { readdir, stat, readFile, access, unlink } from "fs/promises";
import { join, relative, extname, basename, dirname } from "path";
import sharp from "sharp";
import mime from "mime-types";
import { constants } from "fs";
import chokidar from "chokidar";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const prisma = new PrismaClient();

const MEDIA_ROOT = "/media";
const CACHE_ROOT = "/cache";
const THUMB_DIR = join(CACHE_ROOT, "thumbnails");
const PREVIEW_DIR = join(CACHE_ROOT, "previews");
const TEMP_DIR = join(CACHE_ROOT, "temp");

// Directories to permanently ignore — OS metadata
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
]);

// File extensions for which we generate thumbnails/previews
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

function log(level: "INFO" | "WARN" | "ERROR", msg: string, data?: unknown) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] [${level}] ${msg}`;
  if (data) console.log(entry, JSON.stringify(data));
  else console.log(entry);
}

async function updateScannerStatus(status: string) {
  await prisma.systemStatus.upsert({
    where: { key: "scanner_status" },
    update: { value: status },
    create: { key: "scanner_status", value: status },
  });
}

async function sha256(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function ensureDir(dir: string) {
  const { mkdir } = await import("fs/promises");
  await mkdir(dir, { recursive: true });
}

// Generate 320x320 thumbnail
async function generateThumbnail(absolutePath: string, relativePath: string): Promise<string | null> {
  const hash = createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  const thumbPath = join(THUMB_DIR, `${hash}.webp`);
  const thumbRelative = `thumbnails/${hash}.webp`;
  try {
    await access(thumbPath, constants.R_OK);
    return thumbRelative;
  } catch {}

  try {
    await ensureDir(THUMB_DIR);
    await sharp(absolutePath)
      .resize(320, 320, { fit: "cover", position: "centre" })
      .webp({ quality: 75 })
      .toFile(thumbPath);
    return thumbRelative;
  } catch (err) {
    log("WARN", `Thumbnail failed for ${relativePath}`, { error: String(err) });
    return null;
  }
}

// Generate 1920x1920 preview
async function generatePreview(absolutePath: string, relativePath: string): Promise<string | null> {
  const hash = createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  const previewPath = join(PREVIEW_DIR, `${hash}.webp`);
  const previewRelative = `previews/${hash}.webp`;
  try {
    await access(previewPath, constants.R_OK);
    return previewRelative;
  } catch {}

  try {
    await ensureDir(PREVIEW_DIR);
    await sharp(absolutePath)
      .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toFile(previewPath);
    return previewRelative;
  } catch (err) {
    log("WARN", `Preview failed for ${relativePath}`, { error: String(err) });
    return null;
  }
}

// Generate video poster frame
async function generateVideoThumbnail(absolutePath: string, relativePath: string): Promise<string | null> {
  const hash = createHash("sha256").update(relativePath).digest("hex").slice(0, 16);
  const posterPath = join(PREVIEW_DIR, `video-${hash}.webp`);
  const posterRelative = `previews/video-${hash}.webp`;
  try {
    await access(posterPath, constants.R_OK);
    return posterRelative;
  } catch {}

  try {
    await ensureDir(PREVIEW_DIR);
    // Extract frame at 1s, scale maintaining aspect ratio within 320x320
    await execAsync(`ffmpeg -y -ss 1 -i "${absolutePath}" -frames:v 1 -vf "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease" -c:v libwebp -quality 75 "${posterPath}"`);
    return posterRelative;
  } catch (err) {
    log("WARN", `Video thumbnail failed for ${relativePath}`, { error: String(err) });
    return null;
  }
}

async function processFile(absolutePath: string, fileStatObj?: any) {
  const name = basename(absolutePath);
  if (IGNORED_DIRS.has(name) || name.startsWith("._")) return;
  const relativePath = relative(MEDIA_ROOT, absolutePath);
  if (relativePath.includes("/.Trash") || relativePath.includes("/$RECYCLE.BIN")) return;

  try {
    const fileStat = fileStatObj || await stat(absolutePath);
    const ext = extname(name).toLowerCase();
    const mimeType = mime.lookup(name) || null;
    const modifiedAt = fileStat.mtime;

    let checksum: string | null = null;
    if (fileStat.size < 500 * 1024 * 1024) {
      checksum = await sha256(absolutePath);
    }

    const node = await prisma.fileNode.upsert({
      where: { relativePath },
      update: {
        name,
        mimeType: mimeType ?? undefined,
        size: BigInt(fileStat.size),
        modifiedAt,
        sha256: checksum ?? undefined,
        isVisible: true,
      },
      create: {
        relativePath,
        name,
        type: "FILE",
        mimeType: mimeType ?? undefined,
        size: BigInt(fileStat.size),
        modifiedAt,
        sha256: checksum ?? undefined,
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
        const imgMeta = await sharp(absolutePath).metadata();
        await prisma.preview.upsert({
          where: { fileNodeId: node.id },
          update: { cachePath: previewPath },
          create: { fileNodeId: node.id, cachePath: previewPath, width: imgMeta.width ?? 0, height: imgMeta.height ?? 0 },
        });
      }
    } else if (VIDEO_EXTENSIONS.has(ext)) {
      const posterPath = await generateVideoThumbnail(absolutePath, relativePath);
      if (posterPath) {
        await prisma.thumbnail.upsert({
          where: { fileNodeId: node.id },
          update: { cachePath: posterPath },
          create: {
            fileNodeId: node.id,
            cachePath: posterPath,
            width: 320,
            height: 320,
          },
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
  if (!relativePath) return; // Root

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

async function processUnlink(absolutePath: string) {
  const relativePath = relative(MEDIA_ROOT, absolutePath);
  try {
    await prisma.fileNode.deleteMany({ where: { relativePath } });
  } catch (err) {
    log("WARN", `Failed to delete file from DB: ${relativePath}`, { error: String(err) });
  }
}

async function processUnlinkDir(absolutePath: string) {
  const relativePath = relative(MEDIA_ROOT, absolutePath);
  try {
    // Delete dir and all children
    await prisma.fileNode.deleteMany({
      where: {
        OR: [
          { relativePath },
          { relativePath: { startsWith: `${relativePath}/` } }
        ]
      }
    });
  } catch (err) {
    log("WARN", `Failed to delete dir from DB: ${relativePath}`, { error: String(err) });
  }
}

// -------------------------------------------------------------
// Manual Full Rescan
// -------------------------------------------------------------

async function countFiles(dirPath: string): Promise<number> {
  let count = 0;
  let lastReportTime = Date.now();
  async function walk(currentPath: string) {
    try {
      const entries = await readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("._")) continue;
        if (entry.isDirectory()) {
          await walk(join(currentPath, entry.name));
        } else if (entry.isFile()) {
          count++;
        }
      }
    } catch {
      return;
    }
  }
  await walk(dirPath);
  return count;
}

async function scanDirectory(dirPath: string, isIncremental: boolean = true, jobId: string | null = null): Promise<number> {
  let count = 0;
  let lastReportTime = Date.now();
  async function walk(currentPath: string) {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith("._")) continue;
      const absolutePath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await processDirectory(absolutePath);
        await walk(absolutePath);
      } else if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        if (isIncremental) {
          const existing = await prisma.fileNode.findUnique({ where: { relativePath: relative(MEDIA_ROOT, absolutePath) } });
          if (existing && existing.size === BigInt(fileStat.size) && existing.modifiedAt?.getTime() === fileStat.mtime.getTime()) {
            // File metadata unchanged — but still generate missing cache files (thumbnails/previews)
            const ext = extname(entry.name).toLowerCase();
            if (IMAGE_EXTENSIONS.has(ext)) {
              // Run silently — generateThumbnail/Preview return early if cache already exists
              const thumbPath = await generateThumbnail(absolutePath, relative(MEDIA_ROOT, absolutePath));
              const previewPath = await generatePreview(absolutePath, relative(MEDIA_ROOT, absolutePath));
              if (thumbPath && existing.id) {
                await prisma.thumbnail.upsert({
                  where: { fileNodeId: existing.id },
                  update: { cachePath: thumbPath },
                  create: { fileNodeId: existing.id, cachePath: thumbPath, width: 320, height: 320 },
                }).catch(() => {});
              }
              if (previewPath && existing.id) {
                const imgMeta = await sharp(absolutePath).metadata();
                await prisma.preview.upsert({
                  where: { fileNodeId: existing.id },
                  update: { cachePath: previewPath },
                  create: { fileNodeId: existing.id, cachePath: previewPath, width: imgMeta.width ?? 0, height: imgMeta.height ?? 0 },
                }).catch(() => {});
              }
            } else if (VIDEO_EXTENSIONS.has(ext)) {
              const posterPath = await generateVideoThumbnail(absolutePath, relative(MEDIA_ROOT, absolutePath));
              if (posterPath && existing.id) {
                await prisma.thumbnail.upsert({
                  where: { fileNodeId: existing.id },
                  update: { cachePath: posterPath },
                  create: { fileNodeId: existing.id, cachePath: posterPath, width: 320, height: 320 },
                }).catch(() => {});
              }
            }
            continue; // Skip full DB metadata update — file is unchanged
          }
        }
        await processFile(absolutePath, fileStat);
        count++;

        // Report progress every 2 seconds during scan
        if (jobId && Date.now() - lastReportTime > 2000) {
          lastReportTime = Date.now();
          
          // Check for cancellation
          const currentJob = await prisma.scanJob.findUnique({ where: { id: jobId }, select: { status: true } }).catch(() => null);
          if (currentJob && currentJob.status === "CANCELLED") {
            log(`Scan ${jobId} was cancelled by user`);
            break;
          }
          
          await prisma.scanJob.update({ where: { id: jobId }, data: { processedFiles: count } }).catch(() => {});
        }
      }
      // Also tick progress for skipped (unchanged) files
      if (isIncremental) {
        count++;
        if (jobId && Date.now() - lastReportTime > 2000) {
          lastReportTime = Date.now();
          await prisma.scanJob.update({ where: { id: jobId }, data: { processedFiles: count } }).catch(() => {});
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
    try {
      await access(join(MEDIA_ROOT, node.relativePath), constants.F_OK);
    } catch {
      await prisma.fileNode.delete({ where: { id: node.id } });
      pruned++;
    }
  }
  if (pruned > 0) log("INFO", `Pruned ${pruned} deleted nodes from index`);
}

async function runFullScan(jobId: string | null) {
  log("INFO", `Starting FULL scan`, { jobId });
  let totalFiles = 0;
  if (jobId) {
    totalFiles = await countFiles(MEDIA_ROOT);
    await prisma.scanJob.update({
      where: { id: jobId },
      data: { status: "RUNNING", startedAt: new Date(), totalFiles },
    });
  }
  await updateScannerStatus("scanning");

  try {
    const count = await scanDirectory(MEDIA_ROOT, true, jobId);
    await pruneDeletedFiles();

    log("INFO", `Full scan completed`, { filesProcessed: count });
    if (jobId) await prisma.scanJob.update({
      where: { id: jobId! },
      data: { status: "COMPLETED", completedAt: new Date(), processedFiles: totalFiles || count },
    });
  } catch (err) {
    log("ERROR", `Scan failed`, { error: String(err) });
    if (jobId) await prisma.scanJob.update({
      where: { id: jobId! },
      data: { status: "FAILED", completedAt: new Date(), error: String(err) },
    });
  } finally {
    await updateScannerStatus("idle");
  }
}

async function checkForPendingJobs() {
  const job = await prisma.scanJob.findFirst({
    where: { status: "PENDING" },
    orderBy: { requestedAt: "asc" },
  });
  if (job) {
    await runFullScan(job.id);
  }
}

// -------------------------------------------------------------
// Setup
// -------------------------------------------------------------
async function setupWatcher() {
  log("INFO", "Setting up chokidar watcher on " + MEDIA_ROOT);
  const watcher = chokidar.watch(MEDIA_ROOT, {
    persistent: true,
    ignoreInitial: true,
    ignored: (path: string) => {
      const name = basename(path);
      return IGNORED_DIRS.has(name) || name.startsWith("._");
    },
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  watcher
    .on("add", (path) => {
      log("INFO", "File added: " + relative(MEDIA_ROOT, path));
      processFile(path);
    })
    .on("change", (path) => {
      log("INFO", "File changed: " + relative(MEDIA_ROOT, path));
      processFile(path);
    })
    .on("unlink", (path) => {
      log("INFO", "File removed: " + relative(MEDIA_ROOT, path));
      processUnlink(path);
    })
    .on("addDir", (path) => {
      log("INFO", "Dir added: " + relative(MEDIA_ROOT, path));
      processDirectory(path);
    })
    .on("unlinkDir", (path) => {
      log("INFO", "Dir removed: " + relative(MEDIA_ROOT, path));
      processUnlinkDir(path);
    })
    .on("error", (error) => log("ERROR", "Watcher error", { error }));
}

async function mainLoop() {
  log("INFO", "Loom Event-Driven Scanner started");
  await ensureDir(THUMB_DIR);
  await ensureDir(PREVIEW_DIR);
  await ensureDir(TEMP_DIR);

  try {
    log("INFO", "Running startup reconciliation scan...");
    // Create a DB-tracked startup scan job so progress is visible in the UI
    const startupJob = await prisma.scanJob.create({
      data: { type: "FULL", status: "PENDING" }
    });
    await runFullScan(startupJob.id);
    await setupWatcher();
  } catch (err) {
    log("WARN", "Watcher failed to start (drive may be unmounted)");
  }

  while (true) {
    try {
      await checkForPendingJobs();
    } catch (err) {
      log("ERROR", "Job loop error", { error: String(err) });
    }
    // Check for manual scan jobs every 10 seconds
    await new Promise((r) => setTimeout(r, 10000));
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
