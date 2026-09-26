/**
 * recovery.ts — runs once when the web server starts (instrumentation.ts).
 *
 * Finishes or undoes whatever the previous process was doing when it stopped
 * (power cut, crash, restart): see fs-journal.ts. Also marks copy jobs that
 * were running as interrupted — every file they finished copying is complete
 * and kept; the one being copied was a hidden temp file and is removed.
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "./prisma";
import { MEDIA_ROOT } from "./path-security";
import { recoverStaleEntries } from "./fs-journal";
import { ensureDirectoryNodes, upsertFileNodeFromDisk } from "./node-index";
import { queueProcessFile, notifyScanner } from "./jobs";
import { publishChange } from "./events";
import { parentOf } from "./fs-guard";

export async function recoverOnStartup(): Promise<void> {
  try {
    await fs.access(MEDIA_ROOT);
  } catch {
    return; // media folder not mounted (e.g. local development)
  }

  const summary = await recoverStaleEntries({
    async indexRecoveredUpload(finalAbs, sessionId, lastModified) {
      const rel = path.relative(MEDIA_ROOT, finalAbs).split(path.sep).join("/");
      if (lastModified && lastModified > 0 && lastModified < Date.now() + 86_400_000) {
        await fs.utimes(finalAbs, new Date(), new Date(lastModified)).catch(() => {});
      }
      const session = await prisma.uploadSession.findUnique({ where: { id: sessionId }, select: { userId: true } });
      await ensureDirectoryNodes(parentOf(rel));
      const node = await upsertFileNodeFromDisk(rel);
      if (await queueProcessFile(node, session?.userId ?? null)) await notifyScanner();
      await publishChange([parentOf(rel)], [node.id]);
    },
    async dropUploadSession(sessionId) {
      await prisma.uploadSession.deleteMany({ where: { id: sessionId } });
    },
  });

  const jobs = await prisma.backgroundJob
    .updateMany({
      where: { status: { in: ["PENDING", "RUNNING"] } },
      data: { status: "FAILED", error: "Loom restarted before this finished. Files that were already copied are complete and were kept." },
    })
    .catch(() => ({ count: 0 }));

  const parts = [
    summary.uploadsCompleted && `finished indexing ${summary.uploadsCompleted} upload(s)`,
    summary.placeholdersRemoved && `removed ${summary.placeholdersRemoved} empty placeholder(s)`,
    summary.tempsRemoved && `removed ${summary.tempsRemoved} unfinished temporary file(s)`,
    jobs.count && `marked ${jobs.count} interrupted copy job(s)`,
  ].filter(Boolean);
  if (parts.length) console.log(`[recovery] After an interrupted shutdown: ${parts.join(", ")}.`);
}
