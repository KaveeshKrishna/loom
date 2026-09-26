/**
 * send-file.ts — stream a file from disk as an HTTP response.
 *
 * Handles:
 *   - Single byte ranges (bytes=a-b, bytes=a-, bytes=-n) with clamping and
 *     416 for unsatisfiable ranges, plus If-Range.
 *   - Conditional requests (ETag / Last-Modified -> 304).
 *   - RFC 5987 filenames so non-ASCII names download correctly.
 *   - Content-type hardening: user files are served from Loom's own origin,
 *     so anything a browser could execute (HTML, SVG, XML, JS...) is forced
 *     to download, everything gets `nosniff`, and inline responses carry a
 *     sandboxing CSP. This stops an uploaded .html file from running with
 *     the viewer's session.
 */

import { createReadStream } from "fs";
import fs from "fs/promises";
import { Readable } from "stream";
import mime from "mime-types";

/** Types that can be shown inline safely (no script execution possible). */
function isSafeInline(type: string): boolean {
  if (type === "image/svg+xml") return false;
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) return true;
  if (type === "application/pdf") return true;
  return false;
}

/** Text-like types that are safe *as plain text* (rendered, never executed). */
function isTextLike(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "application/x-sh" ||
    type === "application/x-yaml" ||
    type === "application/toml"
  );
}

export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

interface SendOptions {
  filename: string;
  download?: boolean;
  /** Cache-Control value; defaults to private revalidation. */
  cacheControl?: string;
  /** Override the detected content type. */
  contentType?: string;
}

function parseRange(header: string, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or garbage: ignore and send the whole file
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = parseInt(b, 10);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(a, 10);
    end = b === "" ? size - 1 : Math.min(parseInt(b, 10), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

export async function sendFile(req: Request, absPath: string, opts: SendOptions): Promise<Response> {
  const stat = await fs.stat(absPath);
  if (!stat.isFile()) return Response.json({ error: "Not a file" }, { status: 400 });

  const size = stat.size;
  const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const lastModified = stat.mtime.toUTCString();

  const detected = opts.contentType ?? (mime.lookup(opts.filename) || "application/octet-stream");
  let contentType = detected;
  let disposition: "inline" | "attachment" = opts.download ? "attachment" : "inline";
  if (disposition === "inline" && !isSafeInline(detected)) {
    if (isTextLike(detected)) {
      contentType = "text/plain; charset=utf-8"; // show source, never run it
    } else {
      disposition = "attachment";
    }
  }
  if (disposition === "attachment") contentType = opts.download ? "application/octet-stream" : detected;

  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Last-Modified": lastModified,
    "Cache-Control": opts.cacheControl ?? "private, no-cache",
    "Content-Disposition": contentDisposition(disposition, opts.filename),
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (detected !== "application/pdf") {
    // PDF viewers need their plugin; everything else gets a locked-down,
    // script-free sandbox if a browser ever renders it as a document.
    baseHeaders["Content-Security-Policy"] = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";
  }

  // Conditional GET
  const inm = req.headers.get("if-none-match");
  const ims = req.headers.get("if-modified-since");
  if ((inm && inm.split(/\s*,\s*/).includes(etag)) || (!inm && ims && new Date(ims).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  let range: ReturnType<typeof parseRange> = null;
  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const ifRange = req.headers.get("if-range");
    const rangeStillValid = !ifRange || ifRange === etag || ifRange === lastModified;
    if (rangeStillValid) range = parseRange(rangeHeader, size);
  }

  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${size}` } });
  }

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: { ...baseHeaders, "Content-Length": String(size) } });
  }

  if (range) {
    const stream = createReadStream(absPath, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }

  const stream = size === 0 ? null : createReadStream(absPath);
  return new Response(stream ? (Readable.toWeb(stream) as ReadableStream) : null, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
