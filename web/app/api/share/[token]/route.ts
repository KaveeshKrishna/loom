/**
 * GET /api/share/:token — public info about a share link (no login).
 * If the link is password protected and not unlocked yet, only its name is revealed.
 */
import { NextResponse } from "next/server";
import { route } from "@/lib/http";
import { resolveShare } from "@/lib/shares";

export const GET = route<{ params: Promise<{ token: string }> }>(async (_req, { params }) => {
  const { link, root, locked } = await resolveShare((await params).token);
  return NextResponse.json(
    {
      name: root.name,
      type: root.type,
      locked,
      ...(locked
        ? {}
        : {
            mimeType: root.mimeType,
            size: root.size?.toString() ?? null,
            modifiedAt: root.modifiedAt,
            allowDownload: link.allowDownload,
            expiresAt: link.expiresAt,
          }),
    },
    { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } }
  );
});
