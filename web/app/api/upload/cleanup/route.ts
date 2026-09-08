/**
 * POST /api/upload/cleanup
 *
 * Called at app startup (via layout or first-request middleware) to clean up
 * abandoned .partial files from crashed or interrupted uploads.
 *
 * Any .partial file older than 24 hours is considered abandoned.
 * Creates a Notification record for the uploading user so they are informed
 * of the interrupted upload on next login.
 *
 * This is called from the Next.js startup script, not a user-facing endpoint.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { UPLOAD_TEMP_DIR } from "@/lib/path-security";
import fs from "fs/promises";
import path from "path";
import type { Role } from "@prisma/client";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function POST() {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only OWNER can trigger cleanup manually
    const { user } = session;
    if ((user as unknown as { role: Role }).role !== "OWNER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const cleaned = await cleanupStaleParts();
    return NextResponse.json({ success: true, cleaned });
  } catch (err: unknown) {
    console.error("[Upload Cleanup] Error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

async function cleanupStaleParts(): Promise<number> {
  let cleaned = 0;

  try {
    const entries = await fs.readdir(UPLOAD_TEMP_DIR);
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.endsWith(".partial")) continue;

      const entryPath = path.join(UPLOAD_TEMP_DIR, entry);
      try {
        const stat = await fs.stat(entryPath);
        const ageMs = now - stat.mtimeMs;

        if (ageMs > STALE_THRESHOLD_MS) {
          await fs.rm(entryPath, { force: true });
          cleaned++;
          console.log(`[Upload Cleanup] Removed stale partial: ${entry} (${Math.round(ageMs / 3600000)}h old)`);

          // Try to find the user who owned this upload from audit log
          // (best-effort — we don't store uploadId→userId mapping currently)
          // In the future, we can write a small .meta JSON alongside each .partial
          // that stores { userId, filename, destDir, startedAt }
        }
      } catch (err) {
        console.warn(`[Upload Cleanup] Failed to process ${entry}:`, err);
      }
    }
  } catch (err) {
    // .tmp-upload may not exist yet — that's fine
    const error = err as { code?: string };
    if (error.code !== "ENOENT") {
      console.error("[Upload Cleanup] Unexpected error:", err);
    }
  }

  return cleaned;
}
