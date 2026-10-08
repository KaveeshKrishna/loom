# Loom — public demo build

A shareable, **fully fabricated** version of Loom: the same Next.js frontend, built with `NEXT_PUBLIC_DEMO_MODE=1`. Live at [loomdemo.kaveeshkrishna.in](https://loomdemo.kaveeshkrishna.in).

## What it is

The build flag pulls in [`web/lib/demo/`](../web/lib/demo/), which:

- swaps the handful of server-side auth and setup checks for client-only equivalents (there's no database or better-auth session to check against);
- replaces `window.fetch` and `XMLHttpRequest` so every `/api/*` request is answered from fabricated state held in the browser (`mockServer.ts`, `mockUpload.ts`);
- registers a small Service Worker ([`web/public/demo-sw.js`](../web/public/demo-sw.js)) that serves real, generated placeholder photos and videos for `<img>`, `<video>` and download links. Those never go through `fetch()`, so the page-level patch can't reach them.

**There is no backend.** `app/api/` is deleted for this build: a static export can't include Route Handlers that use `headers()` or `cookies()`, and all of ours do. The setup page and the public share-link pages (`app/s/`) are removed too, since they only make sense with a server. The output is static HTML, JS and CSS. It can't read or write anything on the host it's served from, and never talks to a real database, filesystem or authentication server.

Per-visitor changes (renaming a file, editing a text file, moving something to Trash, adding a user, editing permissions) persist in that browser's `localStorage`. The DEMO badge's popup has a **Reset demo** button.

**Login:** any credentials work. The login page has a "Fill demo credentials" button that fills in `demo` / `demo`.

### What behaves differently from a real install

| Feature | In the demo |
|---|---|
| Uploads | Use the same chunked protocol, but the bytes are kept in memory, not stored |
| Share links | Shown as turned off |
| Live updates | Only reflect changes made in the same tab |
| Scan Now | Plays a fabricated progress animation; there's no real scanner |
| File Health → Check again | Does nothing (no scanner) |
| Video | Every video plays one of the bundled placeholder clips natively; no HLS conversion |

## How it's built

[`build.sh`](build.sh) never touches the real `web/` folder. It:

1. copies `web/` into a temporary directory;
2. deletes `app/api/`, `app/(auth)/setup/` and `app/s/`;
3. copies the files in `web/lib/demo/swap/` over their real counterparts (`app/page.tsx`, the login page and form, `app/(main)/layout.tsx`, the settings page, and the root layout);
4. renames the files catch-all page to `FilesPageInner.tsx` and puts a small Server Component wrapper in its place, because `output: "export"` requires `generateStaticParams()` on every dynamic route and a `"use client"` page can't export it;
5. runs `next build` with `NEXT_PUBLIC_DEMO_MODE=1`, which switches `next.config.ts` to `output: "export"`;
6. copies the result to `loom-demo/dist/`.

Nothing under `web/lib/demo/` or `web/components/demo/` is imported by the production build.

## Build

```bash
bash loom-demo/build.sh                  # → loom-demo/dist/
bash loom-demo/build.sh --regen-photos   # also regenerate the placeholder photos first
```

`loom-demo/dist/` is gitignored; it's a build artifact. Re-run the same command after any frontend change, and serve the new `dist/`.

Placeholder videos (`web/public/demo-assets/videos/`) are generated separately with ffmpeg in a throwaway container. They don't need Node or sharp, so keeping that out of `build.sh` keeps it fast:

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

`python3 -m http.server` doesn't work well here. The Next static export writes one `.html` file per route (`login.html`, `photos.html`, …), and the plain Python server won't map `/login` to `login.html`, so routes 404.

For a production proxy you need static file serving plus two fallbacks. Example Caddy block (also in [`Caddyfile.snippet`](Caddyfile.snippet)):

```caddyfile
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

Why the two non-obvious parts matter:

- **`try_files {path} {path}.html /index.html`.** The `{path}.html` step maps `/login` to `login.html`. Without it, every route falls back to `index.html` and you get the site root everywhere.
- **The `/files/*` rewrite.** The file browser is one dynamic catch-all route, and a static export can only prerender one placeholder page for it (`/files/_.html`). Deep links like `/files/Photos/Vacation 2024` must serve that page so the app can read the real path from the URL. Otherwise they fall back to the site root and bounce you to `/files`.

nginx equivalent:

```nginx
server {
    server_name DEMO_DOMAIN;
    root /path/to/loom/loom-demo/dist;

    location /files/ { try_files $uri /files/_.html; }
    location /       { try_files $uri $uri.html /index.html; }
}
```

**One requirement for any host:** `web/public/demo-sw.js` must be served at the site root (`/demo-sw.js`) with a JavaScript content type. Caddy's `file_server` and nginx's default static handling both get this right from the `.js` extension. If you use a CDN or another static host, make sure it doesn't rewrite the file's path or change its scope; a Service Worker can only control pages at or below the path it's served from.

## Testing changes

Curl and build checks aren't enough for this build: a broken demo still returns 200 for every file. After changing anything in `web/lib/demo/`, the swap files, or the files catch-all route, click through it in a real browser (sign in, open nested folders, reload a deep folder URL, run Scan Now). A quick check that the fake backend is actually shipped: `grep -rl demo-sw.js loom-demo/dist/_next` should find a JS chunk (function names like `installFetch` are minified away, so grep for that string instead).
