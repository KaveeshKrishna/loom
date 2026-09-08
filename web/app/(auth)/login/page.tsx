import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { LoginForm } from "./LoginForm";

// Reads the DB on every request (to detect a fresh, user-less install) —
// must not be statically prerendered at build time, when no DB is reachable.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // A brand new install has no users yet — send the visitor to first-run
  // setup instead of a login form for an account that doesn't exist.
  const userCount = await prisma.user.count();
  if (userCount === 0) redirect("/setup");

  return <LoginForm />;
}
