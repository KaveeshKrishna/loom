/**
 * POST /api/fs/rename  { sourcePath, newName, action? }
 * action: "ask" (default — returns 409 with the conflicting item), "skip",
 * "replace" (the existing item goes to Trash first) or "keep_both".
 */
import { NextResponse } from "next/server";
import { route, requireUser, readJson } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { moveItem, parseConflictAction } from "@/lib/file-ops";
import { normalizeRelPath, parentOf } from "@/lib/fs-guard";

export const POST = route(async (req) => {
  const user = await requireUser();
  const body = await readJson<{ sourcePath?: string; newName?: string; action?: string }>(req);
  const src = normalizeRelPath(body.sourcePath);
  const acl = await getAcl(user);
  const result = await moveItem(user, acl, {
    srcRel: src,
    destDirRel: parentOf(src),
    newName: body.newName,
    onConflict: parseConflictAction(body.action),
  });
  const status =
    result.status === "error"
      ? result.error === "Access denied to source" || result.error === "Access denied to destination"
        ? 403
        : 400
      : result.status === "conflict"
        ? 409
        : 200;
  return NextResponse.json(result, { status });
});
