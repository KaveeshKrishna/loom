import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  const ownerName = process.env.OWNER_NAME || "Owner";

  if (!ownerEmail || !ownerPassword) {
    throw new Error("OWNER_EMAIL and OWNER_PASSWORD must be set in environment");
  }

  // Clean slate
  await prisma.user.deleteMany({ where: { email: ownerEmail } });

  // Call the local server to sign up (uses better-auth API)
  const res = await fetch("http://127.0.0.1:3000/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword, name: ownerName }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to sign up via API: ${res.status} ${text}`);
  }

  // Promote to OWNER
  await prisma.user.update({
    where: { email: ownerEmail },
    data: { role: "OWNER" },
  });

  console.log(`✓ Owner account created: ${ownerEmail}`);

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
