import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  const ownerName = process.env.OWNER_NAME || "Owner";

  if (!ownerEmail || !ownerPassword) {
    throw new Error("OWNER_EMAIL and OWNER_PASSWORD must be set in environment");
  }

  // Check if owner already exists
  const existing = await prisma.user.findUnique({
    where: { email: ownerEmail },
  });

  if (!existing) {
    const hash = await bcrypt.hash(ownerPassword, 12);
    await prisma.user.create({
      data: {
        email: ownerEmail,
        name: ownerName,
        passwordHash: hash,
        role: "OWNER",
      },
    });
    console.log(`✓ Owner account created: ${ownerEmail}`);
  } else {
    console.log(`✓ Owner account already exists: ${ownerEmail}`);
  }

  // Initialize system status
  await prisma.systemStatus.upsert({
    where: { key: "archive_status" },
    update: {},
    create: { key: "archive_status", value: "Offline" },
  });

  await prisma.systemStatus.upsert({
    where: { key: "scanner_status" },
    update: {},
    create: { key: "scanner_status", value: "idle" },
  });

  console.log("✓ System status initialized");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
