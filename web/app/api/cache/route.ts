/** GET /api/cache?path=<cachePath> — legacy alias of /api/cache/<cachePath>. */
import { route, requireUser } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { resolveCachePath } from "@/lib/cache-access";
import { sendFile } from "@/lib/send-file";

export const GET = route(async (req) => {
  const user = await requireUser();
  const acl = await getAcl(user);
  const segments = (new URL(req.url).searchParams.get("path") ?? "").split("/");
  const abs = await resolveCachePath(segments, acl);
  return sendFile(req, abs, { filename: segments[segments.length - 1], cacheControl: "private, max-age=604800" });
});
