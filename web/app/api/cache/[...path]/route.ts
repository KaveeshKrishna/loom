/**
 * GET /api/cache/<cachePath> — thumbnails and previews from /cache.
 * Cache paths are content-addressed (content id + profile version), so they
 * can be cached by the browser for a long time. Never publicly cacheable.
 */
import { route, requireUser } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { resolveCachePath } from "@/lib/cache-access";
import { sendFile } from "@/lib/send-file";

export const GET = route<{ params: Promise<{ path: string[] }> }>(async (req, { params }) => {
  const user = await requireUser();
  const acl = await getAcl(user);
  const { path } = await params;
  const abs = await resolveCachePath(path, acl);
  return sendFile(req, abs, {
    filename: path[path.length - 1],
    cacheControl: "private, max-age=604800",
  });
});
