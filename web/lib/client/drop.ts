/**
 * Files and folders from a drag-and-drop.
 *
 * takeDropped() must run inside the drop event itself: the browser empties
 * the DataTransfer as soon as the event is over. It keeps the top-level
 * items (what the user actually dropped); collectDroppedFiles() then walks
 * dropped folders (File System Entries API) so their structure is kept.
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

export interface DroppedItem {
  name: string;
  isDirectory: boolean;
  /** Bytes (files only) */
  size: number;
  entry: FsEntry | null;
  /** The browser's File for it (folders too, in Chromium); null when there's none */
  file: File | null;
}

export interface Dropped {
  items: DroppedItem[];
  /** The items' File objects, in order, for those that have one */
  files: File[];
}

/** What was dropped, read synchronously from the drop event. */
export function takeDropped(dt: DataTransfer): Dropped {
  const items: DroppedItem[] = [];
  for (const i of Array.from(dt.items ?? [])) {
    if (i.kind !== "file") continue;
    const entry = ((i as unknown as { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry?.() ?? null) as FsEntry | null;
    const file = i.getAsFile();
    const name = entry?.name ?? file?.name;
    if (!name) continue;
    items.push({ name, isDirectory: !!entry?.isDirectory, size: entry?.isDirectory ? 0 : (file?.size ?? 0), entry, file });
  }
  if (items.length === 0) {
    // No items API: plain files only.
    for (const file of Array.from(dt.files ?? [])) items.push({ name: file.name, isDirectory: false, size: file.size, entry: null, file });
  }
  return { items, files: items.map((i) => i.file).filter((f): f is File => !!f) };
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

/** Every file in what was dropped, with paths relative to the drop (folders walked). */
export async function collectDroppedFiles(dropped: Dropped): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  for (const item of dropped.items) {
    if (item.entry) await walk(item.entry, "", out);
    else if (item.file && !item.isDirectory) out.push({ file: item.file, relativePath: item.file.name });
  }
  return out;
}

export const LOOM_DRAG_TYPE = "application/x-loom-paths";
