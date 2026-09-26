/**
 * fs-journal.ts — crash safety for multi-step file operations.
 *
 * Before an operation does something that could leave a half-finished result
 * on disk if the server lost power (finalizing an upload, copying a file or
 * folder, saving a text edit), it writes a small journal entry to
 * <media>/.tmp-upload/journal/ and flushes it to disk. The entry is removed
 * when the operation is complete.
 *
 * Every web process has a random BOOT_ID. When Loom starts, any entry written
 * by an earlier process belongs to an operation that died with it, and is
 * recovered (instrumentation.ts → recoverOnStartup):
 *
 *   - "temp":   a .loom-tmp-* file or folder was being written. It is deleted;
 *               the operation never got as far as putting it in place, so
 *               nothing half-written ever shows up in the library.
 *   - "upload": an upload was being moved into place. Either the rename
 *               happened (the file is complete — index it) or it didn't (remove
 *               the empty name placeholder; the upload can still be resumed).
 *
 * Recovery only ever deletes things Loom itself created: paths inside the
 * media folder whose name starts with ".loom-tmp-", or an empty (0-byte)
 * placeholder recorded in the journal.
 */

import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { MEDIA_ROOT, UPLOAD_TEMP_DIR } from "./path-security";

export const BOOT_ID = randomUUID();
export const TEMP_PREFIX = ".loom-tmp-";
export const JOURNAL_DIR = path.join(UPLOAD_TEMP_DIR, "journal");

/** Names Loom uses for its own temporary files (hidden from listings and scans). */
export function isLoomTempName(name: string): boolean {
  return name.startsWith(TEMP_PREFIX) || name.startsWith(".loom-edit-") || name.startsWith(".loom-rename-");
}

export function tempName(): string {
  return `${TEMP_PREFIX}${randomUUID()}`;
}

export type JournalEntry =
  | { kind: "temp"; bootId: string; startedAt: string; tempAbs: string }
  | {
      kind: "upload";
      bootId: string;
      startedAt: string;
      sessionId: string;
      partialAbs: string;
      finalAbs: string;
      size: number;
      lastModified: number | null;
      /** Set once our empty name placeholder exists at finalAbs. */
      placeholder?: boolean;
    };

type NewEntry =
  | { kind: "temp"; tempAbs: string }
  | { kind: "upload"; sessionId: string; partialAbs: string; finalAbs: string; size: number; lastModified: number | null; placeholder?: boolean };

/** Flush a directory entry change (create/rename/delete) to disk. */
export async function fsyncDir(dir: string) {
  try {
    const fh = await fs.open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* some filesystems don't support fsync on directories */
  }
}


export interface JournalHandle {
  id: string;
  /** Update the entry (e.g. once the final path is known). */
  update(patch: Partial<NewEntry>): Promise<void>;
  /** The operation finished: remove the entry. Never throws. */
  done(): Promise<void>;
}

export async function beginJournal(entry: NewEntry): Promise<JournalHandle> {
  await fs.mkdir(JOURNAL_DIR, { recursive: true });
  const id = randomUUID();
  const file = path.join(JOURNAL_DIR, `${id}.json`);
  let current = { ...entry, bootId: BOOT_ID, startedAt: new Date().toISOString() } as JournalEntry;
  const write = async () => {
    const tmp = `${file}.${randomUUID()}.new`;
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(current));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
    await fsyncDir(JOURNAL_DIR);
  };
  await write();
  return {
    id,
    async update(patch) {
      current = { ...current, ...patch } as JournalEntry;
      await write();
    },
    async done() {
      await fs.rm(file, { force: true }).catch(() => {});
    },
  };
}

/** All journal entries (live and stale). */
export async function readJournal(): Promise<{ file: string; entry: JournalEntry }[]> {
  const out: { file: string; entry: JournalEntry }[] = [];
  for (const f of await fs.readdir(JOURNAL_DIR).catch(() => [] as string[])) {
    const file = path.join(JOURNAL_DIR, f);
    if (!f.endsWith(".json")) {
      // Half-written entry from a crash mid-write: harmless, remove.
      await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }
    try {
      out.push({ file, entry: JSON.parse(await fs.readFile(file, "utf8")) });
    } catch {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }
  return out;
}

/** True if `abs` is a Loom temp path inside the media folder (safe to delete). */
export function isDeletableTemp(abs: string): boolean {
  const resolved = path.resolve(abs);
  const root = path.resolve(MEDIA_ROOT);
  return resolved.startsWith(root + path.sep) && path.basename(resolved).startsWith(TEMP_PREFIX);
}

/**
 * Journal a temp file or folder while it's being written, e.g.
 *   const t = await beginTemp(abs); ...write...; move it into place; await t.done();
 */
export async function beginTemp(tempAbs: string): Promise<JournalHandle> {
  if (!isDeletableTemp(tempAbs)) throw new Error(`Refusing to journal a non-temp path: ${tempAbs}`);
  return beginJournal({ kind: "temp", tempAbs });
}

export interface RecoveryHooks {
  /** Index a file an interrupted upload had already moved into place. */
  indexRecoveredUpload(finalAbs: string, sessionId: string, lastModified: number | null): Promise<void>;
  /** Delete the upload session row (the upload is complete). */
  dropUploadSession(sessionId: string): Promise<void>;
}

/** Recover every entry left by an earlier process. Returns what was done, for logging. */
export async function recoverStaleEntries(hooks: RecoveryHooks) {
  const summary = { tempsRemoved: 0, placeholdersRemoved: 0, uploadsCompleted: 0 };
  for (const { file, entry } of await readJournal()) {
    if (entry.bootId === BOOT_ID) continue; // still running in this process
    try {
      if (entry.kind === "temp") {
        if (isDeletableTemp(entry.tempAbs)) {
          await fs.rm(entry.tempAbs, { recursive: true, force: true });
          summary.tempsRemoved++;
        }
      } else if (entry.kind === "upload") {
        const partial = await fs.stat(entry.partialAbs).catch(() => null);
        const final = await fs.lstat(entry.finalAbs).catch(() => null);
        if (partial) {
          // The finished upload never got renamed into place. Remove our empty
          // name reservation, if it's there; the upload stays resumable.
          // Only a placeholder we recorded creating, and only if it's newer
          // than the operation: never a user's own empty file.
          const ours = entry.placeholder === true && final && final.mtimeMs >= Date.parse(entry.startedAt) - 2000;
          if (ours && final.isFile() && final.size === 0 && entry.size !== 0) {
            await fs.rm(entry.finalAbs, { force: true });
            summary.placeholdersRemoved++;
          }
        } else if (final && final.isFile() && final.size === entry.size) {
          // The rename happened; the database update may not have.
          await hooks.indexRecoveredUpload(entry.finalAbs, entry.sessionId, entry.lastModified);
          await hooks.dropUploadSession(entry.sessionId);
          summary.uploadsCompleted++;
        } else {
          await hooks.dropUploadSession(entry.sessionId);
        }
      }
    } catch (err) {
      console.error("[journal] recovery failed for", file, err);
      continue; // keep the entry; try again next start
    }
    await fs.rm(file, { force: true }).catch(() => {});
  }
  return summary;
}
