/**
 * fs-guard.ts
 *
 * Validation for every user-supplied path or file name before it reaches the
 * filesystem. API routes must go through these helpers rather than calling
 * path.join() on request data directly.
 *
 * Rules:
 *   - Relative paths are split on "/" and must not contain "..", NUL or
 *     control characters. Empty and "." segments are dropped.
 *   - Names (a single path segment) additionally must not contain "/", must
 *     not be "." or "..", and must fit in 255 bytes.
 *   - Loom's internal folders (.LoomTrash, .tmp-upload) can never be named,
 *     created or targeted through the normal file APIs.
 *   - ACL checks always run on the *normalized* path, so "Allowed/../Private"
 *     can't slip past a prefix check.
 */

import path from "path";
import { badRequest } from "./http";
import { resolveAndValidate, assertNotInternalPath } from "./path-security";

export const INTERNAL_NAMES = new Set([".LoomTrash", ".tmp-upload"]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Normalize a user-supplied path relative to /media. "" means the root. */
export function normalizeRelPath(input: unknown): string {
  if (input == null || input === "" || input === "/") return "";
  if (typeof input !== "string") throw badRequest("Path must be a string");
  if (CONTROL_CHARS.test(input)) throw badRequest("Path contains invalid characters");
  const segments = input.split("/").filter((s) => s && s !== ".");
  for (const seg of segments) {
    if (seg === "..") throw badRequest("Invalid path");
  }
  if (segments.length > 0 && INTERNAL_NAMES.has(segments[0])) {
    throw badRequest("That folder is reserved for Loom");
  }
  return segments.join("/");
}

/** Validate a single file or folder name. Returns it unchanged if valid. */
export function validateName(input: unknown): string {
  if (typeof input !== "string") throw badRequest("Name must be a string");
  const name = input;
  if (!name.trim()) throw badRequest("Name can't be empty");
  if (name === "." || name === "..") throw badRequest("That name isn't allowed");
  if (name.includes("/")) throw badRequest("Names can't contain /");
  if (CONTROL_CHARS.test(name)) throw badRequest("Name contains invalid characters");
  if (Buffer.byteLength(name, "utf8") > 255) throw badRequest("Name is too long");
  if (INTERNAL_NAMES.has(name)) throw badRequest("That name is reserved for Loom");
  return name;
}

/** Validate a relative path whose every segment must be a valid name. */
export function validateRelativeFilePath(input: unknown): string {
  const rel = normalizeRelPath(input);
  if (!rel) throw badRequest("Path can't be empty");
  rel.split("/").forEach(validateName);
  return rel;
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

export function baseName(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** True if `candidate` is `root` or somewhere below it. */
export function isSameOrDescendant(candidate: string, root: string): boolean {
  return root === "" || candidate === root || candidate.startsWith(root + "/");
}

/**
 * Resolve a normalized relative path to an absolute path under /media,
 * refusing anything that escapes via symlinks or lands in Loom's internal
 * folders.
 */
export async function resolveMediaPath(rel: string, mustExist = false): Promise<string> {
  const abs = await resolveAndValidate(rel, "media", mustExist);
  assertNotInternalPath(abs);
  return abs;
}

/** Like path.join for an absolute parent and a validated name. */
export function childAbs(parentAbs: string, name: string): string {
  return path.join(parentAbs, validateName(name));
}

/** Escape a string for use inside a SQL LIKE pattern (with ESCAPE '\'). */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
