/**
 * POST /api/fs/conflicts — dry run: which files already exist at the
 * destination. Nothing is changed.
 *
 *   { op: "copy" | "move", sourcePaths: string[], destDir }
 *   { op: "upload", destDir, files: [{ path, size, lastModified }] }   (paths relative to destDir)
 *
 * → { conflicts: [{ key, name, existing, incoming, kind, same }], truncated }
 *
 * Folders with the same name merge, so they're never conflicts themselves;
 * the files inside them that collide are listed. The browser asks the user
 * (Replace / Skip / Keep both, "do this for all") and passes the answers to
 * /api/fs/copy, /api/fs/move or the upload.
 */
import { NextResponse } from "next/server";
import { route, requireUser, readJson, badRequest } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { previewTransfer, previewUpload } from "@/lib/transfer";

export const POST = route(async (req) => {
  const user = await requireUser();
  const body = await readJson<{ op?: string; sourcePaths?: unknown; destDir?: unknown; files?: unknown }>(req);
  const acl = await getAcl(user);
  if (body.op === "upload") return NextResponse.json(await previewUpload(acl, body.destDir, body.files));
  if (body.op === "copy" || body.op === "move") return NextResponse.json(await previewTransfer(acl, body.op, body.sourcePaths, body.destDir));
  throw badRequest("op must be copy, move or upload");
});
