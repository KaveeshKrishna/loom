/**
 * POST /api/fs/copy  { sourcePaths: string[], destDir, decisions?, defaultAction? }
 *
 * Starts a background copy and returns { jobId, bytesTotal, filesTotal } at
 * once; progress arrives as live "job" events (and GET /api/fs/jobs/:id).
 *
 * Folders merge into same-named folders at the destination. Files that
 * already exist follow `decisions` (conflict key → "skip" | "replace" |
 * "keep_both", from POST /api/fs/conflicts), else `defaultAction` (default
 * "skip"). Copies are crash-safe and keep modification times.
 */
import { NextResponse } from "next/server";
import { route, requireUser, readJson } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { validateTransfer, parseFileAction, parseDecisions } from "@/lib/transfer";
import { startCopyJob } from "@/lib/copy-jobs";

export const POST = route(async (req) => {
  const user = await requireUser();
  const body = await readJson<{ sourcePaths?: unknown; destDir?: unknown; decisions?: unknown; defaultAction?: unknown; action?: unknown }>(req);
  const acl = await getAcl(user);
  const { destDir, sources } = await validateTransfer(acl, body.sourcePaths, body.destDir);
  const job = await startCopyJob(user, acl, {
    sources,
    destDir,
    decisions: parseDecisions(body.decisions),
    defaultAction: parseFileAction(body.defaultAction ?? body.action),
  });
  return NextResponse.json(job, { status: 202 });
});

