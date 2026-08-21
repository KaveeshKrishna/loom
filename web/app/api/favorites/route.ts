import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const favorites = await prisma.favorite.findMany({
    where: { userId: user.id },
    include: { fileNode: { include: { thumbnail: true, preview: true } } },
    orderBy: { createdAt: "desc" },
  });

  // Serialize BigInt size in nested fileNode
  const serializable = favorites.map((fav) => ({
    ...fav,
    fileNode: {
      ...fav.fileNode,
      size: fav.fileNode.size != null ? fav.fileNode.size.toString() : null,
    },
  }));

  return NextResponse.json({ favorites: serializable });
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
