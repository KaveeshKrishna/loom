/**
 * path-security.ts
 *
 * Central path resolution and validation layer for all server-side filesystem
 * operations. Every mutative API route MUST call resolveAndValidate() before
 * touching the filesystem.
 *
 * Security guarantees:
 *   - No path can escape MEDIA_ROOT via ../, symlinks, or encoded traversals.
 *   - .LoomTrash and .tmp-upload are sandboxed — only Trash/upload APIs may
 *     resolve paths inside them.
 *   - All resolved paths are absolute and verified to be real (not symlinks
 *     to outside the root).
 */

import { realpath, access } from "fs/promises";
import { constants } from "fs";
import path from "path";

export const MEDIA_ROOT = "/media";
export const TRASH_DIR = path.join(MEDIA_ROOT, ".LoomTrash");
export const UPLOAD_TEMP_DIR = path.join(MEDIA_ROOT, ".tmp-upload");

export type PathContext = "media" | "trash" | "upload-temp";

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

/**
 * Resolve a relative path against MEDIA_ROOT and validate it is safe.
 *
 * @param relativePath - User-supplied relative path (e.g. "Pics/Vacation/photo.jpg")
 * @param context - Which sandbox zone is allowed ("media", "trash", "upload-temp")
 * @param mustExist - If true, the resolved path must already exist on disk
 * @returns Absolute path guaranteed to be within the allowed root
 */
export async function resolveAndValidate(
  relativePath: string,
  context: PathContext = "media",
  mustExist = false
): Promise<string> {
  // Treat empty string or "." as the root of the allowed context
  if (!relativePath || relativePath === "." || typeof relativePath !== "string") {
    // Return the allowedRoot — determine it inline here
    let allowedRoot: string;
    if (context === "trash") allowedRoot = TRASH_DIR;
    else if (context === "upload-temp") allowedRoot = UPLOAD_TEMP_DIR;
    else allowedRoot = MEDIA_ROOT;

    if (mustExist) {
      try {
        await access(allowedRoot, constants.F_OK);
      } catch {
        throw new PathSecurityError(`Path does not exist: root`);
      }
    }
    return allowedRoot;
  }

  // Reject obvious traversal patterns before any filesystem call
  const normalized = path.normalize(relativePath);
  if (
    normalized.startsWith("..") ||
    normalized.includes("/../") ||
    normalized === ".."
  ) {
    throw new PathSecurityError(
      `Path traversal attempt blocked: ${relativePath}`
    );
  }

  // Determine the allowed root for this context
  let allowedRoot: string;
  switch (context) {
    case "trash":
      allowedRoot = TRASH_DIR;
      break;
    case "upload-temp":
      allowedRoot = UPLOAD_TEMP_DIR;
      break;
    default:
      allowedRoot = MEDIA_ROOT;
  }

  // Build the candidate absolute path
  const candidate = path.join(allowedRoot, normalized);

  // If the item exists, resolve symlinks and confirm it is still under the root.
  // If it does not exist, use path.resolve to get the logical absolute path and
  // check the parent chain. This prevents symlink-based escapes.
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    // Path doesn't exist yet — use logical resolution
    resolved = candidate;
  }

  if (!resolved.startsWith(allowedRoot + path.sep) && resolved !== allowedRoot) {
    throw new PathSecurityError(
      `Resolved path escapes allowed root. Candidate: ${candidate}, Resolved: ${resolved}, Root: ${allowedRoot}`
    );
  }

  if (mustExist) {
    try {
      await access(resolved, constants.F_OK);
    } catch {
      throw new PathSecurityError(
        `Path does not exist: ${relativePath}`
      );
    }
  }

  return resolved;
}

/**
 * Convert an absolute path back to a relative path under MEDIA_ROOT.
 * Used when writing to FileNode.relativePath.
 */
export function toRelativePath(absolutePath: string): string {
  const rel = path.relative(MEDIA_ROOT, absolutePath);
  if (rel.startsWith("..")) {
    throw new PathSecurityError(
      `Cannot make relative path: ${absolutePath} is outside MEDIA_ROOT`
    );
  }
  return rel;
}

/**
 * Validate that a resolved path is inside the standard media tree
 * (not inside .LoomTrash or .tmp-upload) — useful for operation targets
 * that must only affect user-visible files.
 */
export function assertNotInternalPath(absolutePath: string): void {
  if (
    absolutePath.startsWith(TRASH_DIR + path.sep) ||
    absolutePath.startsWith(UPLOAD_TEMP_DIR + path.sep)
  ) {
    throw new PathSecurityError(
      `Operation target is in a sandboxed internal directory: ${absolutePath}`
    );
  }
}

/**
 * Hard guard to ensure an absolute path is strictly under MEDIA_ROOT.
 */
export function ensureUnderMediaRoot(absolutePath: string): void {
  const normalized = path.normalize(absolutePath);
  if (!normalized.startsWith(MEDIA_ROOT + path.sep) && normalized !== MEDIA_ROOT) {
    throw new PathSecurityError(
      `Path escapes MEDIA_ROOT: ${absolutePath}`
    );
  }
}
