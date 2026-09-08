import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { SetupForm } from "./SetupForm";

// Reads the DB on every request (to gate re-running setup) — must not be
// statically prerendered at build time, when no DB is reachable.
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // Setup is only ever valid once, for the very first account. Once any
  // user exists, this page must not be reachable again.
  const userCount = await prisma.user.count();
  if (userCount > 0) redirect("/login");

  return <SetupForm />;
}
