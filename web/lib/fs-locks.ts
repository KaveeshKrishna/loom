/**
 * fs-locks.ts
 *
 * In-process locks for filesystem paths, so two operations can't touch the
 * same tree at the same time (e.g. moving a folder while a file inside it is
 * being trashed).
 *
 * Locks are hierarchical: a lock on "/media/A" conflicts with a held lock on
 * "/media/A/x" and with one on "/media" — an operation on a folder covers
 * everything beneath it. Loom runs a single web process, so an in-memory
 * registry is enough; the scanner never mutates user-visible paths.
 */

import path from "path";

const activeLocks = new Map<string, number>();

export class FsLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsLockError";
  }
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

function conflictsWithHeld(p: string): boolean {
  for (const held of activeLocks.keys()) {
    if (overlaps(p, held)) return true;
  }
  return false;
}

/**
 * Acquire locks on several paths at once (all-or-nothing). Waits up to
 * `timeoutMs` for conflicting locks to clear. Returns a release function
 * that MUST be called in a finally block.
 */
export async function acquireMultiPathLock(
  absolutePaths: string[],
  timeoutMs = 10_000
): Promise<() => void> {
  const wanted = [...new Set(absolutePaths.map((p) => path.normalize(p)))];
  const start = Date.now();
  while (wanted.some(conflictsWithHeld)) {
    if (Date.now() - start > timeoutMs) {
      throw new FsLockError(`Timeout waiting for lock on: ${wanted.join(", ")}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  for (const p of wanted) activeLocks.set(p, Date.now());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const p of wanted) activeLocks.delete(p);
  };
}

export function acquirePathLock(absolutePath: string, timeoutMs?: number) {
  return acquireMultiPathLock([absolutePath], timeoutMs);
}

export function isPathLocked(absolutePath: string): boolean {
  return conflictsWithHeld(path.normalize(absolutePath));
}
