/**
 * POST /api/upload
 *
 * Streams files directly to /media/.tmp-upload/{uuid}.partial, then atomically
 * renames them to the final destination. Handles collisions via Windows-style
 * auto-rename. Supports upload cancellation — partial files are cleaned up
 * immediately and no FileNode is created.
 *
 * Body: multipart/form-data with fields:
 *   - file: the file blob
 *   - destDir: destination relative path (e.g. "Photos/2024")
 *   - relativePath: optional — for folder uploads, the relative path within the
 *     upload (e.g. "MyFolder/sub/photo.jpg"). The final dest is destDir/relativePath.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { checkAccess } from "@/lib/acl";
import {
  resolveAndValidate,
  UPLOAD_TEMP_DIR,
  MEDIA_ROOT,
  assertNotInternalPath,
} from "@/lib/path-security";
import { generateUniqueFilename } from "@/lib/collision";
import { initFs } from "@/lib/fs-operations";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";

const MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024; // 50 GB hard cap

export const config = {
  api: {
    bodyParser: false,
  },
};

export async function POST(req: NextRequest) {
  let partialPath: string | null = null;

  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { user } = session;

    await initFs(); // ensure .LoomTrash and .tmp-upload exist

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const destDir = formData.get("destDir") as string | null;
    // For folder uploads: relative path within the uploaded folder tree
    const fileRelativePath = formData.get("relativePath") as string | null;

    if (!file || destDir == null) {
      return NextResponse.json(
        { error: "Missing required fields: file, destDir" },
        { status: 400 }
      );
    }

    // ----- ACL check on destination directory -----
    const destAllowed = await checkAccess(
      user.id,
      (user as unknown as { role: Role }).role,
      destDir
    );
    if (!destAllowed) {
      return NextResponse.json({ error: "Access denied to destination" }, { status: 403 });
    }

    // ----- Resolve and validate destination directory -----
    let destDirAbs: string;
    try {
      destDirAbs = await resolveAndValidate(destDir, "media");
    } catch {
      return NextResponse.json({ error: "Invalid destination path" }, { status: 400 });
    }

    assertNotInternalPath(destDirAbs);

    // ----- Build final destination path -----
    // If a relativePath was provided (folder upload), recreate the sub-directory structure
    let finalRelDir = destDir;
    let finalAbsDir = destDirAbs;

    if (fileRelativePath) {
      const subDir = path.dirname(fileRelativePath);
      if (subDir && subDir !== ".") {
        finalRelDir = path.posix.join(destDir, subDir);
        finalAbsDir = path.join(destDirAbs, subDir);
      }
    }

    // Ensure destination directory exists (for folder uploads with sub-dirs)
    await fs.mkdir(finalAbsDir, { recursive: true });

    // Derive the filename from the uploaded file or relativePath leaf
    const originalName = fileRelativePath
      ? path.basename(fileRelativePath)
      : file.name;

    // ----- Size guard -----
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large. Maximum size is 50 GB.` },
        { status: 413 }
      );
    }

    // ----- Stream to .tmp-upload/{uuid}.partial -----
    const uploadId = randomUUID();
    partialPath = path.join(UPLOAD_TEMP_DIR, `${uploadId}.partial`);

    const writeStream = createWriteStream(partialPath);
    const reader = file.stream().getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Check for client disconnect / abort
        if (req.signal.aborted) {
          writeStream.destroy();
          await fs.rm(partialPath, { force: true });
          partialPath = null;
          return NextResponse.json({ error: "Upload cancelled" }, { status: 499 });
        }
        writeStream.write(value);
      }
    } finally {
      reader.releaseLock();
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // ----- Collision resolution — auto-rename for uploads -----
    const uniqueName = await generateUniqueFilename(finalAbsDir, originalName);
    const finalAbsPath = path.join(finalAbsDir, uniqueName);
    const finalRelPath = path.posix.join(finalRelDir, uniqueName);

    // Atomic rename from temp to final location
    await fs.rename(partialPath, finalAbsPath);
    partialPath = null; // cleaned up by rename

    // ----- Index the new file in the database -----
    const stat = await fs.stat(finalAbsPath);
    const sourceVersion = `${stat.size}-${stat.mtimeMs}`;

    // Detect MIME type from extension for basic categorisation
    const ext = path.extname(uniqueName).toLowerCase();
    const mimeType = guessMimeType(ext);

    // Check if a FileNode for this path already exists (shouldn't after unique rename, but be safe)
    const existing = await prisma.fileNode.findFirst({
      where: { relativePath: finalRelPath, inTrash: false },
    });

    if (existing) {
      // Refresh the existing node (content changed)
      await prisma.fileNode.update({
        where: { id: existing.id },
        data: {
          size: BigInt(stat.size),
          modifiedAt: new Date(stat.mtime),
          sourceVersion,
          contentIdentityId: null, // force re-evaluation
          healthStatus: "HEALTHY",
          healthError: null,
          healthCheckedVersion: null,
        },
      });
    } else {
      // Ensure parent directory node exists
      await ensureDirectoryNodes(finalRelDir);

      await prisma.fileNode.create({
        data: {
          relativePath: finalRelPath,
          name: uniqueName,
          type: "FILE",
          mimeType,
          size: BigInt(stat.size),
          modifiedAt: new Date(stat.mtime),
          sourceVersion,
          isVisible: true,
          healthStatus: "HEALTHY",
        },
      });
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPLOAD",
        details: {
          originalName,
          finalPath: finalRelPath,
          size: stat.size,
          renamed: uniqueName !== originalName,
        },
      },
    });

    return NextResponse.json({
      success: true,
      path: finalRelPath,
      name: uniqueName,
      renamed: uniqueName !== originalName,
    });
  } catch (err: unknown) {
    // Clean up partial file on error
    if (partialPath) {
      await fs.rm(partialPath, { force: true }).catch(() => {});
    }
    console.error("[Upload] Error:", err);
    return NextResponse.json(
      { error: (err as Error).message || "Upload failed" },
      { status: 500 }
    );
  }
}

/**
 * Ensures all ancestor directory FileNodes exist for a given relative path.
 * Creates DIRECTORY nodes for any missing segments.
 */
async function ensureDirectoryNodes(relDir: string) {
  // Split the relDir into segments and upsert each level
  const segments = relDir.split("/").filter(Boolean);
  let cumulative = "";

  for (const seg of segments) {
    cumulative = cumulative ? `${cumulative}/${seg}` : seg;
    const absPath = path.join(MEDIA_ROOT, cumulative);

    const existing = await prisma.fileNode.findFirst({
      where: { relativePath: cumulative, type: "DIRECTORY" },
    });

    if (!existing) {
      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue; // skip if not on disk
      }
      await prisma.fileNode.create({
        data: {
          relativePath: cumulative,
          name: seg,
          type: "DIRECTORY",
          mimeType: null,
          size: null,
          modifiedAt: new Date(stat.mtime),
          isVisible: true,
          healthStatus: "HEALTHY",
        },
      });
    }
  }
}

/** Coarse MIME type guess from extension */
function guessMimeType(ext: string): string | null {
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip",
    ".rar": "application/x-rar-compressed",
    ".7z": "application/x-7z-compressed",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".xml": "application/xml",
    ".csv": "text/csv",
  };
  return map[ext] ?? null;
}
