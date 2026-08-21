import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkAccess } from "@/lib/acl";
import { sanitizePath } from "@/lib/utils";
import { getArchiveStatus } from "@/lib/archive";
import { headers } from "next/headers";
import { join, dirname } from "path";
import { createWriteStream } from "fs";
import { stat, mkdir, rename, unlink, access, copyFile } from "fs/promises";
import { constants } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { randomUUID } from "crypto";

const MEDIA_ROOT = "/media";
const CACHE_ROOT = "/cache";
// Stage 1: NVMe temp landing zone (separate filesystem from /media)
const TEMP_DIR = join(CACHE_ROOT, "temp");
// Stage 2: Staging area on the SSD itself (same filesystem as final dest)
// Using a hidden dir so it is never picked up by a FULL_RESCAN walk
const MEDIA_TMP_DIR = join(MEDIA_ROOT, ".tmp-upload");

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const archiveStatus = await getArchiveStatus();
  if (archiveStatus !== "Online") {
    return NextResponse.json({ error: "Archive is offline" }, { status: 503 });
  }

  const destPathRaw = req.nextUrl.searchParams.get("path");
  if (!destPathRaw) return NextResponse.json({ error: "Destination path required" }, { status: 400 });

  const relativePath = sanitizePath(destPathRaw);
  if (!relativePath) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

  // ACL Check: Can the user write to this directory?
  const parentDir = relativePath.includes("/") ? relativePath.split("/").slice(0, -1).join("/") : "";
  const allowed = await checkAccess(user.id, user.role, parentDir);
  if (!allowed) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const finalAbsolutePath = join(MEDIA_ROOT, relativePath);
  if (!finalAbsolutePath.startsWith(MEDIA_ROOT + "/")) {
    return NextResponse.json({ error: "Invalid path boundary" }, { status: 400 });
  }

  // Ensure target doesn't already exist to prevent overwrites
  try {
    await access(finalAbsolutePath, constants.F_OK);
    return NextResponse.json({ error: "File already exists" }, { status: 409 });
  } catch {
    // Expected: file does not exist
  }

  const uploadId = randomUUID();
  // Stage 1 path: NVMe temp (different filesystem from /media)
  const nvcTempPath = join(TEMP_DIR, uploadId);
  // Stage 2 path: SSD staging (same filesystem as final destination — makes rename() atomic)
  const ssdStagingPath = join(MEDIA_TMP_DIR, uploadId);

  // Tracks what has been created so the cleanup function knows what to remove
  let nvcTempCreated = false;
  let ssdStagingCreated = false;
  let finalFileCreated = false;
  let scanJobId: string | null = null;

  /**
   * Full cleanup: remove every artifact created by this upload attempt.
   * Called on any error at any stage. Never throws — we don't want cleanup
   * errors to swallow the original error.
   */
  async function cleanupAll() {
    const tasks: Promise<void>[] = [];
    if (nvcTempCreated) tasks.push(unlink(nvcTempPath).catch(() => {}));
    if (ssdStagingCreated) tasks.push(unlink(ssdStagingPath).catch(() => {}));
    if (finalFileCreated) tasks.push(unlink(finalAbsolutePath).catch(() => {}));
    if (scanJobId) {
      tasks.push(
        prisma.scanJob.delete({ where: { id: scanJobId } }).then(() => {}).catch(() => {})
      );
    }
    await Promise.allSettled(tasks);
  }

  try {
    if (!req.body) {
      throw new Error("No body provided");
    }

    // ── Stage 1: Stream to NVMe temp ────────────────────────────────────────
    await mkdir(TEMP_DIR, { recursive: true });
    const readable = Readable.fromWeb(req.body as import("stream/web").ReadableStream);
    const writeStream = createWriteStream(nvcTempPath);
    await pipeline(readable, writeStream);
    nvcTempCreated = true;

    // ── Verify upload integrity ──────────────────────────────────────────────
    const tempStat = await stat(nvcTempPath);
    if (tempStat.size === 0) {
      throw new Error("Uploaded file is empty — please try again.");
    }
    const expectedSize = req.headers.get("content-length");
    if (expectedSize && parseInt(expectedSize, 10) !== tempStat.size) {
      throw new Error("Upload was interrupted (file size mismatch) — please try again.");
    }

    // ── Stage 2: Copy to SSD staging dir (cross-device safe) ────────────────
    // The .tmp-upload dir is on the same filesystem as /media, so the
    // subsequent rename() to the final path is guaranteed to be atomic.
    await mkdir(MEDIA_TMP_DIR, { recursive: true });
    await copyFile(nvcTempPath, ssdStagingPath);
    ssdStagingCreated = true;

    // NVMe temp is no longer needed — discard it now before touching /media
    await unlink(nvcTempPath).catch(() => {});
    nvcTempCreated = false;

    // ── Stage 3: Atomic rename within SSD ───────────────────────────────────
    const targetDir = dirname(finalAbsolutePath);
    await mkdir(targetDir, { recursive: true });
    await rename(ssdStagingPath, finalAbsolutePath);
    ssdStagingCreated = false; // staging file is now at final path
    finalFileCreated = true;

    // ── Stage 4: Confirm final file exists on T7 ───────────────────────────
    await access(finalAbsolutePath, constants.F_OK);

    // ── Stage 5: Create ScanJob (only now that file is confirmed) ───────────
    const job = await prisma.scanJob.create({
      data: {
        type: "INDEX_FILE",
        status: "PENDING",
        requestedBy: user.id,
        targetPath: relativePath,
      },
    });
    scanJobId = job.id;

    return NextResponse.json({ success: true, path: relativePath });
  } catch (error) {
    // Full cleanup: temp files, staging, final file, and any ScanJob created
    await cleanupAll();

    const message = error instanceof Error ? error.message : "Upload failed";
    console.error(`[UPLOAD] Failed (id=${uploadId}):`, message);

    return NextResponse.json(
      {
        error: message,
        detail: "The upload could not be completed. All temporary data has been removed. Please try uploading the file again.",
      },
      { status: 500 }
    );
  }
}
