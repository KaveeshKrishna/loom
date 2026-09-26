/**
 * copy-jobs.ts — copies run in the background.
 *
 * Copying a big folder can take far longer than a proxy lets a request live
 * (Cloudflare gives up after 100 s), so POST /api/fs/copy starts a job and
 * returns at once. Progress is published as live events (type "job") to the
 * user who started it, and can be polled at GET /api/fs/jobs/:id. A job can
 * be cancelled; files already copied stay, the one in progress is discarded.
 *
 * Jobs live in this process. If Loom restarts mid-copy, recovery.ts marks the
 * job as interrupted and fs-journal.ts removes the unfinished temp file.
 */
import { prisma } from "./prisma";
import type { AclEvaluator } from "./acl";
import { publish, publishChange } from "./events";
import { runTransfer, measureSources, type FileAction, type TransferSummary } from "./transfer";
import type { SessionUser } from "./http";

const g = globalThis as unknown as { __loomCopyJobs?: Map<string, AbortController> };
const running = (g.__loomCopyJobs ??= new Map());

export async function startCopyJob(
  user: SessionUser,
  acl: AclEvaluator,
  opts: { sources: string[]; destDir: string; decisions: Record<string, FileAction>; defaultAction: FileAction }
) {
  const totals = await measureSources(opts.sources);
  const job = await prisma.backgroundJob.create({
    data: {
      type: "COPY",
      status: "RUNNING",
      userId: user.id,
      payload: { sources: opts.sources.slice(0, 100), destDir: opts.destDir, bytesTotal: totals.bytes, filesTotal: totals.files },
    },
  });
  const ctrl = new AbortController();
  running.set(job.id, ctrl);
  void run(job.id, user, acl, opts, totals, ctrl.signal).finally(() => running.delete(job.id));
  return { jobId: job.id, bytesTotal: totals.bytes, filesTotal: totals.files };
}

export function cancelCopyJob(id: string): boolean {
  const ctrl = running.get(id);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

async function run(
  id: string,
  user: SessionUser,
  acl: AclEvaluator,
  opts: { sources: string[]; destDir: string; decisions: Record<string, FileAction>; defaultAction: FileAction },
  totals: { bytes: number; files: number },
  signal: AbortSignal
) {
  let bytesDone = 0;
  let filesDone = 0;
  let lastEvent = 0;
  let lastSave = 0;
  const progress = () =>
    totals.bytes > 0 ? Math.min(99, Math.floor((bytesDone / totals.bytes) * 100)) : totals.files ? Math.min(99, Math.floor((filesDone / totals.files) * 100)) : 0;
  const event = (status: string, extra: { summary?: TransferSummary; error?: string } = {}) =>
    publish({
      type: "job",
      job: {
        id,
        kind: "COPY",
        status,
        userId: user.id,
        progress: status === "COMPLETED" ? 100 : progress(),
        bytesDone,
        bytesTotal: totals.bytes,
        filesDone,
        filesTotal: totals.files,
        ...extra,
      },
    });

  try {
    const { summary } = await runTransfer(user, acl, {
      op: "copy",
      sources: opts.sources,
      destDir: opts.destDir,
      decisions: opts.decisions,
      defaultAction: opts.defaultAction,
      signal,
      onProgress: (b, f) => {
        bytesDone += b;
        filesDone += f;
        const now = Date.now();
        if (now - lastEvent > 700) {
          lastEvent = now;
          void event("RUNNING");
        }
        if (now - lastSave > 5000) {
          lastSave = now;
          void prisma.backgroundJob.update({ where: { id }, data: { progress: progress() } }).catch(() => {});
        }
      },
    });
    const status = signal.aborted ? "CANCELLED" : summary.done === 0 && summary.failed > 0 ? "FAILED" : "COMPLETED";
    await prisma.backgroundJob.update({
      where: { id },
      data: {
        status,
        progress: status === "COMPLETED" ? 100 : progress(),
        error: status === "FAILED" ? summary.errors[0]?.error ?? "Copy failed" : null,
        payload: { sources: opts.sources.slice(0, 100), destDir: opts.destDir, bytesTotal: totals.bytes, filesTotal: totals.files, summary: summary as object },
      },
    });
    await event(status, { summary });
  } catch (err) {
    const message = (err as Error).message || "Copy failed";
    await prisma.backgroundJob.update({ where: { id }, data: { status: "FAILED", error: message } }).catch(() => {});
    await event("FAILED", { error: message });
  }
  await publishChange([opts.destDir]);
}
