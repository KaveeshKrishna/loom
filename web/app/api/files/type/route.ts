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

  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type") ?? "";
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10), 500);
  const cursor = searchParams.get("cursor") ?? null;

  let mimeTypeFilter: object = {};
  if (type === "image") {
    mimeTypeFilter = { startsWith: "image/" };
  } else if (type === "video") {
    mimeTypeFilter = { startsWith: "video/" };
  } else if (type === "document") {
    mimeTypeFilter = { startsWith: "application/" };
  } else {
    return NextResponse.json({ nodes: [], nextCursor: null });
  }

  const results = await prisma.fileNode.findMany({
    where: {
      isVisible: true,
      mimeType: mimeTypeFilter,
    },
    include: { thumbnail: true, preview: true },
    orderBy: { updatedAt: "desc" },
    take: limit + 1,                    // fetch one extra to determine if there's a next page
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

  // Determine next cursor
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  // Filter by ACL for non-owners
  if (user.role !== "OWNER") {
    const filtered = await Promise.all(
      page.map(async (r) => {
        const allowed = await checkAccess(user.id, user.role, r.relativePath);
        return allowed ? r : null;
      })
    );
    const allowed = filtered.filter(Boolean) as typeof page;
    return NextResponse.json({
      nodes: serializeNodes(allowed),
      nextCursor: allowed.length === limit ? nextCursor : null,
    });
  }

  return NextResponse.json({ nodes: serializeNodes(page), nextCursor });
}
