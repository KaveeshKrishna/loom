/**
 * Process a single file: make sure its index row matches the disk, resolve
 * its content identity, then generate whatever derived media is missing.
 * Used by PROCESS_FILE jobs (after uploads/edits) and INDEX_FILE jobs.
 */
import { stat } from "fs/promises";
import { join, extname, basename } from "path";
import mime from "mime-types";
import {
  prisma,
  log,
  MEDIA_ROOT,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  sourceVersionOf,
  parentOf,
  publishChange,
  isUniqueViolation,
} from "./common.js";
import { resolveContentIdentity, processImage, processVideo } from "./media.js";

export function isProcessable(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

function isInternal(rel: string): boolean {
  return rel.startsWith(".tmp-upload/") || rel.startsWith(".LoomTrash/") || rel === ".tmp-upload" || rel === ".LoomTrash";
}

/** Generate derived media for an indexed node. Returns false if the node/file is gone. */
export async function processNodeById(fileNodeId: string, force = false): Promise<boolean> {
  const node = await prisma.fileNode.findUnique({
    where: { id: fileNodeId },
    include: { contentIdentity: { include: { thumbnail: true, preview: true } } },
  });
  if (!node || node.inTrash || node.type !== "FILE" || isInternal(node.relativePath)) return false;

  const abs = join(MEDIA_ROOT, node.relativePath);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return false; // moved or deleted since the job was queued; nothing to do
  }
  if (!st.isFile()) return false;

  const sv = sourceVersionOf(st.size, st.mtimeMs);
  let ci = node.contentIdentity;
  if (node.sourceVersion !== sv) {
    // Changed on disk since it was indexed: refresh the row, drop the old identity.
    await prisma.fileNode.update({
      where: { id: node.id },
      data: { size: BigInt(st.size), modifiedAt: st.mtime, sourceVersion: sv, contentIdentityId: null, browserCompatible: null },
    });
    ci = null;
  }
  if (!isProcessable(node.name)) return true;
  if (!ci) ci = await resolveContentIdentity(abs, st.size, node.id);

  const ext = extname(node.name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    await processImage(abs, ci, node.id, sv, force);
  } else {
    await processVideo(abs, ci, { id: node.id, mimeType: node.mimeType, browserCompatible: ci === node.contentIdentity ? node.browserCompatible : null }, sv, force);
  }
  await publishChange([node.parentPath], [node.id], "processed");
  return true;
}

/** Legacy INDEX_FILE: index one path (creating its row if needed), then process it. */
export async function indexAndProcessPath(rel: string): Promise<void> {
  if (isInternal(rel)) return;
  const abs = join(MEDIA_ROOT, rel);
  const st = await stat(abs);
  if (!st.isFile()) return;
  const data = {
    name: basename(rel),
    parentPath: parentOf(rel),
    type: "FILE" as const,
    mimeType: mime.lookup(rel) || null,
    size: BigInt(st.size),
    modifiedAt: st.mtime,
    sourceVersion: sourceVersionOf(st.size, st.mtimeMs),
    isVisible: true,
  };
  let node = await prisma.fileNode.findFirst({ where: { relativePath: rel, inTrash: false } });
  if (!node) {
    try {
      node = await prisma.fileNode.create({ data: { relativePath: rel, ...data } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      node = await prisma.fileNode.findFirstOrThrow({ where: { relativePath: rel, inTrash: false } });
    }
  }
  const ok = await processNodeById(node.id);
  if (!ok) log("WARN", `INDEX_FILE: nothing to process for ${rel}`);
}
