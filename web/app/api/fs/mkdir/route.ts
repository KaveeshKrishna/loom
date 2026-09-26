/**
 * POST /api/fs/mkdir  { parentPath, name }
 * Creates a folder. If the name is taken, a free "name (1)" variant is used.
 */
import { NextResponse } from "next/server";
import { route, requireUser, readJson } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { makeDirectory } from "@/lib/file-ops";

export const POST = route(async (req) => {
  const user = await requireUser();
  const { parentPath, name } = await readJson<{ parentPath?: string; name?: string }>(req);
  const acl = await getAcl(user);
  const result = await makeDirectory(user, acl, parentPath ?? "", name ?? "");
  return NextResponse.json({ success: true, ...result });
});
