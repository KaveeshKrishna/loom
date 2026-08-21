import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SettingsShell } from "@/components/settings/SettingsShell";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user || user.role !== "OWNER") redirect("/files");

  return <SettingsShell />;
}
