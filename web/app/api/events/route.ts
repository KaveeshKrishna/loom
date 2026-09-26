/**
 * GET /api/events — Server-Sent Events stream of index changes.
 *
 * Browsers subscribe once and refresh only the folder that changed (a new
 * upload, a thumbnail finishing in the background, another user's edit).
 * Events are filtered by the viewer's permissions. A comment ping every 25 s
 * keeps proxies from closing the idle connection.
 *
 * Reverse proxies must not buffer this route (nginx: proxy_buffering off —
 * see docs/REVERSE-PROXY.md).
 */
import { route, requireUser } from "@/lib/http";
import { getAcl } from "@/lib/acl";
import { subscribe, type LoomEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const user = await requireUser();
  const acl = await getAcl(user);
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const onEvent = (ev: LoomEvent) => {
        if (ev.type === "job") {
          if (ev.job?.userId && ev.job.userId !== user.id && !acl.isOwner) return;
        } else if (!acl.isOwner && ev.dirs?.length) {
          const dirs = ev.dirs.filter((d) => acl.canTraverse(d));
          if (dirs.length === 0) return;
          ev = { ...ev, dirs };
        }
        send(`data: ${JSON.stringify(ev)}\n\n`);
      };
      const unsubscribe = await subscribe(onEvent);
      const ping = setInterval(() => send(`: ping\n\n`), 25_000);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", () => cleanup());
      send(`retry: 5000\n: connected\n\n`);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
