/**
 * POST /api/download/zip (form or JSON: path=... repeated)
 * Streams the chosen files/folders as one ZIP. Permission rules are applied
 * to every entry; items the user can't read are silently left out.
 */
import { route, requireUser, badRequest, forbidden } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { normalizeRelPath, resolveMediaPath } from "@/lib/fs-guard";
import { zipResponse, uniqueZipNames } from "@/lib/zip";
import { prisma } from "@/lib/prisma";

export const POST = route(async (req) => {
  const user = await requireUser();
  let raw: unknown[] = [];
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    raw = Array.isArray(body.paths) ? body.paths : [];
  } else {
    const form = await req.formData();
    raw = form.getAll("path");
  }
  const paths = [...new Set(raw.map((p) => normalizeRelPath(p)))].slice(0, 1000);
  if (paths.length === 0) throw badRequest("Nothing to download");

  const acl = await getAcl(user);
  const allowed = paths.filter((p) => acl.canTraverse(p));
  if (allowed.length === 0) throw forbidden();
  for (const p of allowed) await resolveMediaPath(p, true);

  const date = new Date().toISOString().slice(0, 10);
  const name = allowed.length === 1 ? `${allowed[0].split("/").pop() || "Home"}.zip` : `Loom ${date}.zip`;
  await prisma.auditLog.create({ data: { userId: user.id, action: "DOWNLOAD_ZIP", details: { paths: allowed.slice(0, 50), count: allowed.length } } });
  return zipResponse(uniqueZipNames(allowed), name, (rel, isDir) => (isDir ? acl.canTraverse(rel) : acl.canAccess(rel)));
});
