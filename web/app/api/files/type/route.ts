import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { checkAccess } from "@/lib/acl";
import { serializeNodes } from "@/lib/utils";
import { headers } from "next/headers";

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const type = req.nextUrl.searchParams.get("type") ?? "";
  
  let mimeTypeFilter: object = {};
  if (type === "image") {
    mimeTypeFilter = { startsWith: "image/" };
  } else if (type === "video") {
    mimeTypeFilter = { startsWith: "video/" };
  } else if (type === "document") {
    mimeTypeFilter = { startsWith: "application/" }; // simplistic view for documents
  } else {
    return NextResponse.json({ nodes: [] });
  }

  const results = await prisma.fileNode.findMany({
    where: {
      isVisible: true,
      mimeType: mimeTypeFilter,
    },
    include: { thumbnail: true, preview: true },
    orderBy: { updatedAt: "desc" },
  });

  // Filter by ACL for non-owners
  if (user.role !== "OWNER") {
    const filtered = await Promise.all(
      results.map(async (r) => {
        const allowed = await checkAccess(user.id, user.role, r.relativePath);
        return allowed ? r : null;
      })
    );
    return NextResponse.json({ nodes: serializeNodes(filtered.filter(Boolean) as typeof results) });
  }

  return NextResponse.json({ nodes: serializeNodes(results) });
}
