/**
 * zip.ts — stream files and folders as a ZIP without temp files.
 *
 * Walks the real filesystem (the source of truth), never follows symlinks,
 * skips Loom's internal folders, and asks `allow(rel)` for every entry so
 * permission rules are applied per file. Already-compressed media is stored
 * as-is (no CPU spent recompressing video); other files are deflated.
 * archiver switches to ZIP64 automatically for archives over 4 GB.
 */
import archiver from "archiver";
import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { Readable, PassThrough } from "stream";
import { MEDIA_ROOT } from "./path-security";
import { INTERNAL_NAMES } from "./fs-guard";
import { isLoomTempName } from "./fs-journal";
import { contentDisposition } from "./send-file";

const STORE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|m4v|mov|mkv|webm|avi|mp3|m4a|aac|flac|ogg|opus|zip|rar|7z|gz|bz2|xz|zst|pdf|docx|xlsx|pptx)$/i;

export interface ZipRoot {
  /** Path relative to /media */
  rel: string;
  /** Name of this item inside the archive */
  nameInZip: string;
}

export function zipResponse(roots: ZipRoot[], archiveName: string, allow: (rel: string, isDir: boolean) => boolean): Response {
  const archive = archiver("zip", { zlib: { level: 6 }, forceZip64: false });
  const out = new PassThrough();
  archive.on("warning", (err) => console.warn("[zip] warning:", err.message));
  archive.on("error", (err) => {
    console.error("[zip] error:", err.message);
    out.destroy(err);
  });
  archive.pipe(out);

  (async () => {
    const addFile = async (abs: string, name: string) => {
      const st = await fs.stat(abs);
      archive.append(createReadStream(abs), { name, date: st.mtime, store: STORE_EXT.test(name) });
    };
    const walk = async (rel: string, name: string) => {
      const abs = path.join(MEDIA_ROOT, rel);
      const st = await fs.lstat(abs).catch(() => null);
      if (!st || st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        if (!allow(rel, true)) return;
        archive.append("", { name: name + "/", date: st.mtime });
        for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
          if (INTERNAL_NAMES.has(entry.name) || isLoomTempName(entry.name) || entry.isSymbolicLink()) continue;
          await walk(rel ? `${rel}/${entry.name}` : entry.name, `${name}/${entry.name}`);
        }
      } else if (st.isFile() && allow(rel, false)) {
        await addFile(abs, name);
      }
    };
    try {
      for (const r of roots) await walk(r.rel, r.nameInZip);
      await archive.finalize();
    } catch (err) {
      archive.abort();
      out.destroy(err as Error);
    }
  })();

  return new Response(Readable.toWeb(out) as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition("attachment", archiveName),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** De-duplicate names at the top level of an archive. */
export function uniqueZipNames(rels: string[]): ZipRoot[] {
  const used = new Map<string, number>();
  return rels.map((rel) => {
    const base = rel.split("/").pop() || "Home";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const ext = path.extname(base);
    const name = n === 0 ? base : `${ext ? base.slice(0, -ext.length) : base} (${n})${ext}`;
    return { rel, nameInZip: name };
  });
}
