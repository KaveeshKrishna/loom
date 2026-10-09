#!/usr/bin/env node
/**
 * Reset a Loom user's password from the server's command line — for when the
 * only Owner is locked out.
 *
 *   docker compose exec loom-web node scripts/reset-password.mjs you@example.com
 *
 * You'll be asked for the new password (it isn't echoed, and isn't left in
 * your shell history). The user is signed out everywhere, apps included.
 * Anyone who can run this already controls the server, so it grants nothing
 * new.
 *
 * The hash format matches Better Auth's (scrypt N=16384 r=16 p=1, 64 bytes,
 * "salt:key" in hex), so the normal sign-in accepts it.
 */
import { randomBytes, scrypt } from "node:crypto";
import readline from "node:readline";
import { PrismaClient } from "@prisma/client";

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const N = 16384, r = 16, p = 1;
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, 64, { N, r, p, maxmem: 128 * N * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(`${salt}:${key.toString("hex")}`)
    )
  );
}

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      rl._writeToOutput = (s) => {
        if (s.startsWith(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden && process.stdin.isTTY) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const email = (process.argv[2] || "").trim().toLowerCase();
  if (!email) {
    console.error("Usage: node scripts/reset-password.mjs <email>");
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const users = await prisma.user.findMany({ select: { email: true, role: true }, orderBy: { createdAt: "asc" } });
      console.error(`No user with email ${email}. Users: ${users.map((u) => `${u.email} (${u.role})`).join(", ") || "none"}`);
      process.exit(1);
    }
    const pw = process.env.LOOM_NEW_PASSWORD ?? (await ask("New password (at least 8 characters): ", true));
    if (pw.length < 8) {
      console.error("Password must be at least 8 characters. Nothing was changed.");
      process.exit(1);
    }
    if (!process.env.LOOM_NEW_PASSWORD && process.stdin.isTTY) {
      const again = await ask("Repeat it: ", true);
      if (again !== pw) {
        console.error("The passwords didn't match. Nothing was changed.");
        process.exit(1);
      }
    }
    const hash = await hashPassword(pw);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { password: hash } });
      const updated = await tx.account.updateMany({ where: { userId: user.id, providerId: "credential" }, data: { password: hash } });
      if (updated.count === 0) {
        await tx.account.create({ data: { accountId: user.id, providerId: "credential", userId: user.id, password: hash } });
      }
      await tx.session.deleteMany({ where: { userId: user.id } });
      // Paired apps too (lib/devices.ts). loom-web caches device lookups for
      // up to 15 seconds, then they stop working.
      await tx.device.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({ data: { userId: user.id, action: "USER_UPDATED", details: { targetId: user.id, targetEmail: user.email, changed: ["password"], via: "reset-password script" } } });
    });
    console.log(`Password for ${user.email} (${user.role}) was reset. They've been signed out everywhere.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
