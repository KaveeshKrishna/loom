import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { checkAccess } from "@/lib/acl";
import { sanitizePath, serializeNodes } from "@/lib/utils";
import { headers } from "next/headers";

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const rawPath = searchParams.get("path") ?? "";
  const path = sanitizePath(rawPath);

  // ACL check: does the user have access to this path?
  const allowed = await checkAccess(user.id, user.role, path);
  if (!allowed) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Fetch directory contents from file index
  const prefix = path ? `${path}/` : "";

  // Get all nodes under this path (one level deep)
  const allNodes = await prisma.fileNode.findMany({
    where: {
      isVisible: true,
      relativePath: {
        startsWith: prefix,
      },
    },
    include: {
      thumbnail: true,
      preview: true,
    },
  });

  // Filter to only direct children (one level deep)
  const children = allNodes.filter((node) => {
    const rest = node.relativePath.slice(prefix.length);
    return !rest.includes("/");
  });

  return NextResponse.json({ path, children: serializeNodes(children) });
}
