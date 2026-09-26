/**
 * Text files, for the in-browser editor.
 *
 * GET  /api/files/content?path=            → { content, version, size }
 * POST /api/files/content { parentPath, name, content? } → create a new text file
 * PUT  /api/files/content { path, content, baseVersion } → save
 *
 * Saving is safe:
 *  - baseVersion (the file's size+mtime when it was opened) must still match
 *    the disk, otherwise 409 — nobody's changes are silently overwritten;
 *  - the previous contents are kept in Trash as a "previous version" for 15
 *    days (restorable like any deleted file);
 *  - the new contents are written to a temp file in the same folder, flushed,
 *    and renamed over the original, so a crash never leaves a half-written file.
 */
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { beginTemp, fsyncDir, tempName, type JournalHandle } from "@/lib/fs-journal";
import { prisma } from "@/lib/prisma";
import { route, requireUser, readJson, badRequest, forbidden, conflict, HttpError } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { normalizeRelPath, validateName, resolveMediaPath, baseName, parentOf, joinRel } from "@/lib/fs-guard";
import { acquireMultiPathLock } from "@/lib/fs-locks";
import { ensureDirectoryNodes, upsertFileNodeFromDisk, sourceVersionOf } from "@/lib/node-index";
import { saveVersionToTrash } from "@/lib/file-ops";
import { publishChange } from "@/lib/events";
import { isEditableName, looksBinary, MAX_EDITABLE_BYTES } from "@/lib/text-files";

export const GET = route(async (req) => {
  const user = await requireUser();
  const rel = normalizeRelPath(req.nextUrl.searchParams.get("path"));
  if (!rel) throw badRequest("Path required");
  const acl = await getAcl(user);
  if (!acl.canAccess(rel)) throw forbidden();
  const abs = await resolveMediaPath(rel, true);
  const st = await fs.stat(abs);
  if (!st.isFile()) throw badRequest("Not a file");
  if (st.size > MAX_EDITABLE_BYTES) throw new HttpError(413, "This file is too large to open in the editor (limit 5 MB)");
  const buf = await fs.readFile(abs);
  if (looksBinary(buf)) throw new HttpError(415, "This doesn't look like a text file");
  return NextResponse.json(
    {
      content: buf.toString("utf8"),
      version: sourceVersionOf(st),
      size: st.size,
      editable: isEditableName(baseName(rel)),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const body = await readJson<{ parentPath?: string; name?: string; content?: string }>(req);
  const parent = normalizeRelPath(body.parentPath);
  const name = validateName(body.name ?? "");
  const content = typeof body.content === "string" ? body.content : "";
  if (Buffer.byteLength(content) > MAX_EDITABLE_BYTES) throw new HttpError(413, "Too large");
  const acl = await getAcl(user);
  if (!acl.canTraverse(parent) || !acl.canAccess(joinRel(parent, name))) throw forbidden();
  const parentAbs = await resolveMediaPath(parent, true);

  // O_EXCL: never overwrite; pick "name (1).ext" if taken.
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let finalName = name;
  for (let n = 1; ; n++) {
    try {
      await fs.writeFile(path.join(parentAbs, finalName), content, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 1000) throw err;
      finalName = `${base} (${n})${ext}`;
    }
  }
  const rel = joinRel(parent, finalName);
  await ensureDirectoryNodes(parent);
  const node = await upsertFileNodeFromDisk(rel);
  await prisma.auditLog.create({ data: { userId: user.id, action: "CREATE_FILE", details: { path: rel } } });
  await publishChange([parent], [node.id]);
  return NextResponse.json({ path: rel, name: finalName, id: node.id }, { status: 201 });
});

export const PUT = route(async (req) => {
  const user = await requireUser();
  const body = await readJson<{ path?: string; content?: unknown; baseVersion?: string }>(req);
  const rel = normalizeRelPath(body.path);
  if (!rel) throw badRequest("Path required");
  if (typeof body.content !== "string") throw badRequest("content must be a string");
  if (Buffer.byteLength(body.content) > MAX_EDITABLE_BYTES) throw new HttpError(413, "Too large to save from the editor (limit 5 MB)");
  const acl = await getAcl(user);
  if (!acl.canAccess(rel)) throw forbidden();
  if (!isEditableName(baseName(rel))) throw badRequest("This file type can't be edited in the browser");

  const abs = await resolveMediaPath(rel, true);
  const release = await acquireMultiPathLock([abs]);
  const tmp = path.join(path.dirname(abs), tempName());
  let journal: JournalHandle | null = null;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) throw badRequest("Not a file");
    if (body.baseVersion && body.baseVersion !== sourceVersionOf(st)) {
      throw conflict("The file changed on disk since you opened it. Reload to see the latest version, or save a copy.", {
        currentVersion: sourceVersionOf(st),
      });
    }
    if (looksBinary((await fs.readFile(abs)).subarray(0, 8192))) throw badRequest("Not a text file");

    await saveVersionToTrash(user, rel, abs);

    // The new contents go to a hidden temp file first; if the power goes out
    // mid-write, the original stays untouched and the temp file is removed on
    // the next start (fs-journal.ts).
    journal = await beginTemp(tmp);
    const fh = await fs.open(tmp, "wx", st.mode & 0o777);
    try {
      await fh.writeFile(body.content, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, abs);
    await fsyncDir(path.dirname(abs));
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  } finally {
    await journal?.done();
    release();
  }

  const node = await upsertFileNodeFromDisk(rel);
  await prisma.auditLog.create({ data: { userId: user.id, action: "EDIT", details: { path: rel, size: Number(node.size ?? 0) } } });
  await publishChange([parentOf(rel), ".LoomTrash"], [node.id]);
  return NextResponse.json({ success: true, version: node.sourceVersion, size: Number(node.size ?? 0) });
});
