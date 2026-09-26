/**
 * POST /api/fs/move  { sourcePaths: string[], destDir, decisions?, defaultAction? }
 *
 * Folders merge into same-named folders at the destination (a source folder
 * is removed once everything in it has moved). Files that already exist
 * follow `decisions` (conflict key → "skip" | "replace" | "keep_both", from
 * POST /api/fs/conflicts), else `defaultAction` (default "skip").
 *
 * → { results: [...], summary: { done, skipped, failed, errors } }
 */
import { NextResponse } from "next/server";
import { route, requireUser, readJson } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { validateTransfer, runTransfer, parseFileAction, parseDecisions } from "@/lib/transfer";

export const POST = route(async (req) => {
  const user = await requireUser();
  const body = await readJson<{ sourcePaths?: unknown; destDir?: unknown; decisions?: unknown; defaultAction?: unknown; action?: unknown }>(req);
  const acl = await getAcl(user);
  const { destDir, sources } = await validateTransfer(acl, body.sourcePaths, body.destDir);
  return NextResponse.json(
    await runTransfer(user, acl, {
      op: "move",
      sources,
      destDir,
      decisions: parseDecisions(body.decisions),
      defaultAction: parseFileAction(body.defaultAction ?? body.action),
    })
  );
});
