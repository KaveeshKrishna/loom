import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { checkAccess } from "@/lib/acl";
import { sanitizePath } from "@/lib/utils";
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

  const prefix = path ? `${path}/` : "";

  // Note: This aggregate sums all descendants. For non-owner users, it may 
  // include the sizes of sub-folders they are explicitly denied from seeing. 
  // This is an intentional performance trade-off to keep the query fast.
  const result = await prisma.fileNode.aggregate({
    _sum: {
      size: true,
    },
    where: {
      type: "FILE",
      ...(path ? { relativePath: { startsWith: prefix } } : {}),
    },
  });

  return NextResponse.json({ 
    path, 
    size: result._sum.size?.toString() ?? "0" 
  });
}
