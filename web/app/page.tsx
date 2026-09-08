import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

// Reads the DB on every request (to decide setup-vs-login-vs-files) —
// must not be statically prerendered at build time, when no DB is reachable.
export const dynamic = "force-dynamic";

export default async function RootPage() {
  const userCount = await prisma.user.count();
  if (userCount === 0) redirect("/setup");
  redirect("/files");
}
