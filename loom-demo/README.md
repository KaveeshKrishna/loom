# Loom public demo

A shareable, completely fake version of Loom. Same Next.js frontend, built with `NEXT_PUBLIC_DEMO_MODE=1`.

## What it is

That flag pulls in [`web/lib/demo/`](../web/lib/demo/), which:

- swaps the few server-side auth and setup checks for client-only versions (there's no database or better-auth session to check)
- replaces `window.fetch` and `XMLHttpRequest` so every `/api/*` request is answered from fake state in the browser
- registers a small Service Worker ([`web/public/demo-sw.js`](../web/public/demo-sw.js)) to serve generated placeholder photos and videos for `<img>`, `<video>`, and download links, since those don't go through `fetch()` and the page-level patch can't see them

There is no backend. `app/api/` is removed for this build (a static export can't include Route Handlers that use `headers()` or `cookies()`, and all of ours do). The output is static HTML, JS, and CSS. It can't read or write anything on the host serving it, and it never talks to a real database, filesystem, or auth server.

Changes a visitor makes (rename a file, move something to trash, add a user, edit permissions) are saved in that browser's `localStorage`. The DEMO badge popup has a **Reset demo** button.

Login: anything works. There's a "Fill demo credentials" button that fills in `demo` / `demo`.

## Build

```bash
bash loom-demo/build.sh                  # -> loom-demo/dist/
bash loom-demo/build.sh --regen-photos   # regenerate placeholder photos first
```

`loom-demo/dist/` is gitignored. It's a build artifact. Run the same command again after any frontend change.

Placeholder videos (`web/public/demo-assets/videos/`) are made separately with ffmpeg in a throwaway container. They don't need Node or sharp, so keeping that out of `build.sh` keeps it fast:

```bash
cd web/public/demo-assets/videos
UID_GID="$(id -u):$(id -g)"
docker run --rm --user "$UID_GID" -v "$(pwd):/out" -w /out jrottenberg/ffmpeg:4.4-alpine \
  -f lavfi -i "testsrc=size=640x360:rate=30:duration=6" -pix_fmt yuv420p -movflags +faststart /out/clip-01.mp4
# clip-02.mp4: testsrc2, clip-03.mp4: smptebars, clip-04.mp4: mandelbrot (same flags, different -i filter)
```

## Serve

It's a static site, so any static host works. To check locally:

```bash
npx serve loom-demo/dist
```

Heads up: `python3 -m http.server` won't work well here. The Next static export makes a `.html` file per route (`login.html`, `photos.html`, and so on) and the plain Python server won't map `/login` to `login.html`, so routes 404. `npx serve` mostly handles it. The Caddy and nginx configs below handle it properly.

For a real proxy you need static file serving plus a couple of fallbacks. Example Caddy block (see [`Caddyfile.snippet`](./Caddyfile.snippet)):

```
http://DEMO_DOMAIN {
    root * /path/to/loom/loom-demo/dist
    encode gzip

    @filesRoute {
        path /files/*
        not path /files/_.html
        not path /files/_.txt
    }
    rewrite @filesRoute /files/_.html

    try_files {path} {path}.html /index.html
    file_server
}
```

Why the two odd parts:

- `try_files {path} {path}.html /index.html`: the `.html` step is what maps `/login` to `login.html`. Without it, every route falls back to `index.html` and you get the site root everywhere.
- The `/files/*` rewrite: the file browser is one dynamic catch-all route, and a static export can only prerender one placeholder page for it (`/files/_.html`). Deep links like `/files/Photos/Vacation 2024` have to serve that page so the app can read the real path from the URL. Otherwise they fall back to the site root and bounce you to `/files`.

nginx version of the same idea:

```nginx
server {
    server_name DEMO_DOMAIN;
    root /path/to/loom/loom-demo/dist;

    location /files/ { try_files $uri /files/_.html; }
    location /       { try_files $uri $uri.html /index.html; }
}
```

One more thing for either proxy: `web/public/demo-sw.js` has to be served at the site root (`/demo-sw.js`) with a JavaScript content type. Caddy's `file_server` and nginx's default static handling both get this from the `.js` extension, so no special config. If you use a CDN or a different host, make sure it doesn't rewrite the file's path or change its scope. A Service Worker can only control pages at or below the path it's served from.
