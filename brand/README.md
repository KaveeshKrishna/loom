# Loom's mark

Three warp threads and three weft threads, woven over and under. A loom
turns loose threads into cloth; Loom turns files scattered across folders
and drives into one ordered place, without moving them.

- `mark.py` draws the mark (one source for every size and platform) and
  writes the SVGs here plus the Android vector drawables.
- `build.sh` renders the PNG and ICO files for the website
  (`web/app/icon.svg`, `favicon.ico`, `apple-icon.png`, `web/public/icons/`)
  and the Windows app (`clients/desktop/src-tauri/icons/`). It uses Docker,
  so nothing is installed on your machine.

```bash
bash brand/build.sh
```

Colours: Loom blue `#1A5FF0`, warp `#B5CBFF`, weft `#FFFFFF`. In one
colour (Android's themed icon, notifications) the gaps between threads
stay open, so the weave still reads.
