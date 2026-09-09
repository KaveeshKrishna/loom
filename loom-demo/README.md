# Loom — public demo build

A shareable, **fully fabricated** version of Loom — the same Next.js
frontend, built with `NEXT_PUBLIC_DEMO_MODE=1`.

## What it is

That flag pulls in [`web/lib/demo/`](../web/lib/demo/), which:

- swaps the handful of server-side auth/setup checks for client-only
  equivalents (there's no database or better-auth session to check against)
- replaces `window.fetch` and `XMLHttpRequest` so every `/api/*` request is
  answered from fabricated state held in the browser
- registers a small Service Worker ([`web/public/demo-sw.js`](../web/public/demo-sw.js))
  to serve real (generated) placeholder photos/videos for `<img>`/`<video>`/
  download links — those never go through `fetch()`, so the page-level
  patch alone can't reach them

**There is no backend.** `app/api/` is deleted entirely for this build (a
static export can't include Route Handlers that use `headers()`/`cookies()`,
which all of ours do). The build output is static HTML/JS/CSS — it cannot
read or write anything on the host it's served from, and it never talks to
a real database, filesystem, or authentication server.

Per-visitor changes (renaming a file, moving something to trash, adding a
user, editing permissions) persist in that browser's `localStorage`; the
DEMO badge's popup has a **Reset demo** button.

Login: any credentials work. There's a "Fill demo credentials" button on
the login page that fills in `demo` / `demo`.

## Build

```bash
bash loom-demo/build.sh              # → loom-demo/dist/
bash loom-demo/build.sh --regen-photos  # also regenerate placeholder photos first
```

`loom-demo/dist/` is gitignored — it's a build artifact. Rebuild with the
same command after any frontend change. Placeholder videos
(`web/public/demo-assets/videos/`) are generated separately, via ffmpeg in
a throwaway container (they don't need Node/sharp, so keeping that out of
`build.sh`'s normal path keeps it fast):

```bash
cd web/public/demo-assets/videos
UID_GID="$(id -u):$(id -g)"
docker run --rm --user "$UID_GID" -v "$(pwd):/out" -w /out jrottenberg/ffmpeg:4.4-alpine \
  -f lavfi -i "testsrc=size=640x360:rate=30:duration=6" -pix_fmt yuv420p -movflags +faststart /out/clip-01.mp4
# clip-02.mp4: testsrc2, clip-03.mp4: smptebars, clip-04.mp4: mandelbrot (same flags, different -i filter)
```

## Serve

It's a static SPA, so any static host works. To check locally:

```bash
npx serve loom-demo/dist
# or:  cd loom-demo/dist && python3 -m http.server 4173
```

For a production reverse proxy you only need static file serving with an
SPA fallback. Example Caddy block (see [`Caddyfile.snippet`](./Caddyfile.snippet)):

```
http://DEMO_DOMAIN {
    root * /path/to/loom/loom-demo/dist
    encode gzip
    try_files {path} /index.html
    file_server
}
```

nginx equivalent:

```nginx
server {
    server_name DEMO_DOMAIN;
    root /path/to/loom/loom-demo/dist;
    location / { try_files $uri /index.html; }
}
```

**One thing that matters for either proxy**: `web/public/demo-sw.js` must
be served at the site root (`/demo-sw.js`) with `Content-Type:
application/javascript` (or `text/javascript`) — both Caddy's `file_server`
and nginx's default static handling get this right automatically from the
`.js` extension, so no special config is needed, but if you use a CDN or
different static host, make sure it doesn't rewrite the file's path or
strip its scope (Service Workers can only control pages at or below the
path they're served from).
