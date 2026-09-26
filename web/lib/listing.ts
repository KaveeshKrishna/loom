/**
 * listing.ts — shared shapes for returning FileNodes to the browser.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { toJson } from "./http";

export const nodeInclude = {
  contentIdentity: { include: { thumbnail: true, preview: true } },
} satisfies Prisma.FileNodeInclude;

export type ListedNode = Prisma.FileNodeGetPayload<{ include: typeof nodeInclude }>;

/**
 * Serialize nodes for JSON and flag the ones whose thumbnail/preview is still
 * being generated in the background, so the UI can show a placeholder and
 * wait for the live update instead of a generic icon.
 */
export type SerializedNode = Record<string, unknown> & { id: string; processing: boolean };

export async function serializeListed(nodes: ListedNode[]): Promise<SerializedNode[]> {
  const ids = nodes.filter((n) => n.type === "FILE" && !n.contentIdentity?.thumbnail).map((n) => n.id);
  let processing = new Set<string>();
  if (ids.length > 0) {
    const jobs = await prisma.scanJob.findMany({
      where: { type: "PROCESS_FILE", status: { in: ["PENDING", "RUNNING"] }, fileNodeId: { in: ids } },
      select: { fileNodeId: true },
    });
    processing = new Set(jobs.map((j) => j.fileNodeId!));
  }
  return (toJson(nodes) as (Record<string, unknown> & { id: string })[]).map((n) => ({
    ...n,
    processing: processing.has(n.id),
  }));
}
