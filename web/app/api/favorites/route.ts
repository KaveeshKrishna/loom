import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10), 500);
  const cursor = searchParams.get("cursor") ?? null;

  const favorites = await prisma.favorite.findMany({
    where: { userId: user.id, fileNode: { inTrash: false } },
    include: { fileNode: { include: { contentIdentity: { include: { thumbnail: true, preview: true } } } } },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

  const hasMore = favorites.length > limit;
  const page = hasMore ? favorites.slice(0, limit) : favorites;
  const nextCursor = hasMore ? page[page.length - 1].id : null;

  // Serialize BigInt size in nested fileNode
  const serializable = page.map((fav) => ({
    ...fav,
    fileNode: {
      ...fav.fileNode,
      size: fav.fileNode.size != null ? fav.fileNode.size.toString() : null,
    },
  }));

  return NextResponse.json({ favorites: serializable, nextCursor });
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { fileNodeId } = await req.json();

  const existing = await prisma.favorite.findUnique({
    where: { userId_fileNodeId: { userId: user.id, fileNodeId } },
  });

  if (existing) {
    await prisma.favorite.delete({
      where: { userId_fileNodeId: { userId: user.id, fileNodeId } },
    });
    return NextResponse.json({ favorited: false });
  } else {
    await prisma.favorite.create({ data: { userId: user.id, fileNodeId } });
    return NextResponse.json({ favorited: true });
  }
}
