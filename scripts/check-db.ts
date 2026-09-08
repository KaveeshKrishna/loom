/**
 * check-db.ts — quick sanity check of indexed/derived-media counts.
 *
 * Run from inside the web container (it needs the generated Prisma client
 * and a reachable DATABASE_URL):
 *
 *   docker compose exec loom-web npx tsx /dev/stdin < scripts/check-db.ts
 *
 * or copy it into web/ temporarily and run `npx tsx check-db.ts` there.
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const nodes = await prisma.fileNode.count();
  const thumbs = await prisma.thumbnail.count();
  const prevs = await prisma.preview.count();
  const videos = await prisma.videoCache.count();
  console.log(`nodes: ${nodes}, thumbs: ${thumbs}, prevs: ${prevs}, videos: ${videos}`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
