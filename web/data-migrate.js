import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('Migrating old job types...');
  await prisma.$executeRawUnsafe(`UPDATE scan_jobs SET type = 'FULL_RESCAN' WHERE type IN ('FULL', 'INCREMENTAL')`);
  console.log('Done.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
