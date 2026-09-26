/**
 * Collect files from a drag-and-drop, including dropped folders (walked
 * recursively with the File System Entries API so their structure is kept).
 */

export interface DroppedFile {
  file: File;
  relativePath: string;
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (cb: (entries: FsEntry[]) => void, err: (e: unknown) => void) => void };
}

async function walk(entry: FsEntry, prefix: string, out: DroppedFile[]) {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((res, rej) => entry.file!(res, rej));
    out.push({ file, relativePath: prefix + entry.name });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries returns results in batches; keep reading until empty.
    for (;;) {
      const batch = await new Promise<FsEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

export async function collectDroppedFiles(dt: DataTransfer): Promise<DroppedFile[]> {
  const items = Array.from(dt.items ?? []);
  const entries: FsEntry[] = [];
  for (const i of items) {
    if (i.kind !== "file") continue;
    const e = (i as unknown as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry?.();
    if (e) entries.push(e as FsEntry);
  }
  if (entries.length === 0) {
    return Array.from(dt.files).map((file) => ({ file, relativePath: file.name }));
  }
  const out: DroppedFile[] = [];
  for (const e of entries) await walk(e, "", out);
  return out;
}

export const LOOM_DRAG_TYPE = "application/x-loom-paths";
