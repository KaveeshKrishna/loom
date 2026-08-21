import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { checkAccess } from "@/lib/acl";
import { serializeNodes } from "@/lib/utils";
import { headers } from "next/headers";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const nodes = await prisma.fileNode.findMany({
    where: { isVisible: true, type: "FILE" },
    include: { thumbnail: true, preview: true },
    orderBy: { modifiedAt: "desc" },
    take: 100,
  });

  if (user.role === "OWNER") return NextResponse.json({ nodes: serializeNodes(nodes) });

  const filtered = (await Promise.all(nodes.map(async (n) => ({
    node: n, allowed: await checkAccess(user.id, user.role, n.relativePath),
  })))).filter(r => r.allowed).map(r => r.node).slice(0, 50);

  return NextResponse.json({ nodes: serializeNodes(filtered) });
}
