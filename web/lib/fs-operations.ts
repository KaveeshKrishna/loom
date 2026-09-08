import fs from "fs/promises";
import { TRASH_DIR, UPLOAD_TEMP_DIR } from "./path-security";

let initialized = false;

/**
 * Ensures that the required internal directories exist on the media drive.
 * This should be called at application startup or before any FS operation.
 */
export async function initFs() {
  if (initialized) return;

  try {
    // We don't create MEDIA_ROOT; it must be mounted by the OS.
    // We only create the internal sandboxed directories.
    await fs.mkdir(TRASH_DIR, { recursive: true });
    await fs.mkdir(UPLOAD_TEMP_DIR, { recursive: true });
    initialized = true;
    console.log("[FS] Initialized internal directories (.LoomTrash, .tmp-upload)");
  } catch (error) {
    console.error("[FS] Failed to initialize internal directories:", error);
    throw error;
  }
}
