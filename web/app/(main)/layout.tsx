import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MainShell } from "@/components/layout/MainShell";

export default async function MainLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { email: session.user.email! },
  });
  if (!user) redirect("/login");

  return (
    <MainShell
      userName={user.name}
      userEmail={user.email}
      isOwner={user.role === "OWNER"}
    >
      {children}
    </MainShell>
  );
}
