/**
 * GET /api/files/serve?path=...&download=1
 * Streams an original file (with Range support) to a signed-in user who is
 * allowed to read it. See lib/send-file.ts for the content-type hardening.
 */
import { route, requireUser, forbidden, badRequest } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { normalizeRelPath, resolveMediaPath, baseName } from "@/lib/fs-guard";
import { sendFile } from "@/lib/send-file";

async function handle(req: Request) {
  const user = await requireUser();
  const url = new URL(req.url);
  const rel = normalizeRelPath(url.searchParams.get("path"));
  if (!rel) throw badRequest("Path required");
  const acl = await getAcl(user);
  if (!acl.canAccess(rel)) throw forbidden();
  const abs = await resolveMediaPath(rel, true);
  return sendFile(req, abs, { filename: baseName(rel), download: url.searchParams.get("download") === "1" });
}

export const GET = route(handle);
export const HEAD = route(handle);
