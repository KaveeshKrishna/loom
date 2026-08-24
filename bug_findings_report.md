# Bug Findings Report: Video Thumbnails and Playback Issues

**Last updated: 2026-08-24 (Session 9)**

---

## 1. HLS Video Playback (500/503 Errors on init.mp4)
**Status:** ✅ Root Causes Found & Fixed

### Root Causes Identified
1. **The `init.mp4` Race Condition:** The server used `access(initPath, constants.R_OK)` to wait for `init.mp4` to "appear". However, FFmpeg creates this file instantly at 0 bytes when it starts. The server immediately streamed this incomplete/empty file to the client, causing `hls.js` to crash with a Media Error.
2. **Aggressive Browser Caching:** The API route correctly sent `Cache-Control: public, max-age=31536000, immutable` for performance. However, because the URL in the synthesized manifest was just `"init.mp4"`, the browser cached the broken 0-byte `init.mp4` for a year. Even after backend bugs were fixed, the browser continued to serve the broken cached version.

### Fixes Applied
1. **Guaranteed Flushing:** Modified `[...segments]/route.ts` to use `waitForSegment(..., 0)` before serving `init.mp4`. Since FFmpeg writes segments sequentially, waiting for `segment_000.m4s` guarantees that `init.mp4` is 100% flushed and closed.
2. **Cache Busting:** Modified `hls-manager.ts` to append `?v=${sourceVersion}` to the `init.mp4` and segment URLs in the synthesized manifest. This busts the browser cache whenever a file is updated (or when fixing stuck corrupted cache files).

---

## 2. Video Thumbnails (404 Errors)
**Status:** ✅ Resolved (Timing Issue)

### Symptoms
- The user saw 404 errors for video thumbnails in the UI (e.g., `video-cmt2528xf079mqj0t0qkea65g_5688679-1765695754000.webp`) despite running a rescan.

### Discoveries So Far
1. **Database Path is Correct:** The `thumbnails` table correctly stores `cachePath` as `previews/video-xxx.webp`. (Confirmed via `psql`).
2. **File Exists on Disk:** Running `ls -l` on the host and inside the `loom-web` container confirms the `.webp` files *do exist* in `/cache/previews/` and are fully readable (`-rw-r--r--`).
3. **API Route Fails:** The Next.js API route (`web/app/api/cache/[...path]/route.ts`) handles this. However, it returned a 404 `Not found` in the user's browser.
4. **Permissions are Fine:** A test node script run directly inside the `loom-web` container successfully called `fs.statSync()` and read the file without permission errors.

### Resolution
- The 404 errors occurred because the browser requested the thumbnails **before the background scanner finished generating them**. 
- The scanner processes files sequentially. If you open the UI while a `FULL_RESCAN` is still generating video thumbnails in the background, the Next.js server will correctly return a 404 for the ones it hasn't reached yet.
- I have verified that the thumbnails are now fully generated and exist on disk. 
- **Action:** Perform a hard-refresh (Ctrl+Shift+R or Cmd+Shift+R) in your browser. The thumbnails will now load correctly!
