/**
 * fs-locks.ts
 *
 * Provides in-memory locking for filesystem paths to prevent concurrent mutative
 * operations (e.g. moving a file while it is being deleted).
 *
 * In a multi-instance setup, this would be backed by Redis. For a single-instance
 * personal app like Loom, an in-memory Map is sufficient.
 */

const activeLocks = new Set<string>();

export class FsLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FsLockError";
  }
}

/**
 * Acquire an exclusive lock on a path.
 * Will wait if the lock is held, up to a timeout.
 * Returns a release function that MUST be called in a finally block.
 */
export async function acquirePathLock(
  absolutePath: string,
  timeoutMs = 5000
): Promise<() => void> {
  const startTime = Date.now();

  while (activeLocks.has(absolutePath)) {
    if (Date.now() - startTime > timeoutMs) {
      throw new FsLockError(`Timeout waiting for lock on: ${absolutePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  activeLocks.add(absolutePath);

  return () => {
    activeLocks.delete(absolutePath);
  };
}

/**
 * Check if a path is currently locked.
 */
export function isPathLocked(absolutePath: string): boolean {
  return activeLocks.has(absolutePath);
}

/**
 * Acquire locks for multiple paths at once (e.g. source and destination of a move).
 * Locks are sorted to prevent deadlocks.
 */
export async function acquireMultiPathLock(
  absolutePaths: string[],
  timeoutMs = 5000
): Promise<() => void> {
  // Sort paths to guarantee consistent lock ordering (prevents deadlocks)
  const sorted = [...new Set(absolutePaths)].sort();
  const releases: Array<() => void> = [];

  try {
    for (const path of sorted) {
      const release = await acquirePathLock(path, timeoutMs);
      releases.push(release);
    }
    return () => {
      // Release in reverse order
      while (releases.length > 0) {
        releases.pop()!();
      }
    };
  } catch (err) {
    // If we fail halfway through, release everything we acquired so far
    while (releases.length > 0) {
      releases.pop()!();
    }
    throw err;
  }
}
