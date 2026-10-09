# Using Loom

A tour of what you can do once Loom is running. For installation see [INSTALLATION.md](INSTALLATION.md).

## Uploading

Drag files or whole folders onto any folder view, or use **New → Upload files / Upload folder**. Dropping files onto a folder tile uploads them into that folder. Loom asks before uploading anything you dropped ("Upload 3 files to Photos?"), so a stray drop never starts an upload.

- **Progress.** The upload panel in the corner shows overall progress, speed and time remaining. You can minimize it to a small pill that keeps showing progress; click the pill to bring the panel back.
- **Pause, resume, cancel.** Pause or cancel each file in the panel, or use **Pause all**, **Resume all** and **Cancel all**. A paused upload keeps what was already sent and continues from there.
- **"Uploaded" means stored.** A file is marked Uploaded as soon as every byte is safely on disk and verified. Its thumbnail appears a few seconds later ("preview generating in background").
- **Interruptions.** If your connection drops, uploads retry on their own. If you close the tab or the server loses power, the upload panel lists the unfinished uploads the next time you open Loom. Pick the same files again (in the same folder) within 24 hours to resume where they stopped, even from another browser, or click **Discard** to free the space. Unfinished files never show up in your folders.
- **Files that already exist.** Before anything is sent, Loom asks what to do with each file that's already there: **Replace** (the old one goes to Trash), **Skip**, or **Keep both** (the new one becomes `name (1).ext`). Tick "Do this for the other N conflicts" to answer them all at once. Both files' size and date are shown, and probable duplicates are flagged.
- **Resuming a folder upload.** After an interrupted folder upload, pick the same folder again and choose Skip for all. Only what's missing is uploaded, with no `photo (1).jpg` duplicates.
- **Downloads** are run by your browser: pause or cancel them in its downloads list (Ctrl+J in most browsers). The [Loom apps](APPS.md) have their own downloads with pause and resume.
- **When Loom is unreachable** (restarting after an update, or you're offline), a bar at the top says "Can't reach Loom. Reconnecting…" and disappears once it's back. If Loom was updated meanwhile, open pages reload themselves (after your uploads finish, if any are running).

## Selecting and organizing

- **Selecting.** Click the circle on a tile, Ctrl/Cmd-click, or Shift-click for a range. On a phone, long-press; after that, taps add or remove items.
- **Bulk actions.** With items selected, the bar at the top can Download (as a ZIP), Move to, Copy to, Star, or move them to Trash.
- **Context menu.** Right-click (or the ⋮ button) on anything for every action: open, download, rename, move, copy, cut/copy/paste, star, pin to the sidebar, share link, details, and move to Trash.
- **Dragging.** Drag items onto a folder, a breadcrumb, a pinned folder, or All Files to move them. Hold Alt or Ctrl while dropping to copy instead.
- **Name clashes when moving or copying.** Folders with the same name merge, like in Windows. For each file that already exists, Loom asks Replace / Skip / Keep both, with "Do this for the other N conflicts". A file and a folder with the same name can't replace each other, so only Keep both or Skip applies there.
- **Background copies.** Copying runs in the background with a progress bar and a Cancel button. Cancelling keeps the files already copied; the one in progress is discarded, never left half-copied.
- **Undo.** Most actions (move, rename, delete) show an Undo button for a few seconds.
- **Pinned folders.** Pin any folder to the sidebar. Pins follow the folder when it's renamed or moved.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Arrow keys | Move between items (Shift extends the selection) |
| Enter | Open |
| Alt + Enter | Show details |
| Space | Select / deselect |
| Ctrl/Cmd + A | Select all |
| Ctrl/Cmd + C / X / V | Copy / cut / paste |
| F2 | Rename |
| Delete (or Cmd + Backspace) | Move to Trash |
| Esc | Clear the selection |
| / | Search |
| ← / → (viewer) | Previous / next file |
| i (viewer) | Details |
| Esc (viewer) | Close |
| Ctrl/Cmd + S (editor) | Save |

## Viewing and editing

Click a file to open the viewer. The filmstrip at the bottom shows the other files in the folder, in the same order as the folder view.

| Type | What you get |
|---|---|
| Photos | A fast preview first; **Original** loads the full file. Zoom with the scroll wheel, a pinch or a double-click, drag to pan, and a slideshow mode. |
| Videos | Play immediately. Formats your browser can't play natively are converted on the fly, and you can seek anywhere. |
| Audio | Plays with auto-advance to the next track. |
| PDFs | Open in your browser's built-in PDF viewer. |
| Text, code, Markdown | Shown with syntax highlighting; Markdown is rendered. Files up to 5 MB can be edited. |

**Editing text files.** Click **Edit**, make your changes, then **Save** (or Ctrl/Cmd + S). If the file changed on disk while you were editing, Loom asks before overwriting. The previous version is always kept in Trash for 15 days, marked "previous version". **New → New text file** creates a file and opens it in the editor.

**Downloading.** Single files download directly. Any selection of files and folders downloads as one ZIP, generated on the fly with no size limit.

## Search, sorting and filters

- **Search** covers the current folder and its sub-folders. The globe button searches your whole library. Exact and prefix matches come first.
- **Sorting.** The sort button in the toolbar sorts by name, date, size or type. In list view you can also click the column headers.
- **Filters.** The chips in the toolbar (Photos, Videos, Audio, Documents, Folders) filter what you see.
- **Library-wide views.** Photos, Videos, Audio, Documents, Starred and Recent in the sidebar cover your whole library, regardless of folder.

## Share links

Right-click a file or folder and choose **Share link…** to create a link anyone can open without an account.

- **Options.** An expiry (1 day to never), an optional password, and whether visitors may download. The link is copied to your clipboard as soon as it's created.
- **What visitors can do.** Browse a shared folder, preview photos, browser-playable videos, audio and PDFs, and download single files or everything as a ZIP (if downloads are allowed).
- **Managing links.** **Shared links** in the sidebar lists the links you've made. Delete one there and it stops working immediately. Links keep working when the item is renamed or moved, and pause while it's in Trash.
- **Who can share.** Sharing is off by default. Once the Owner turns it on in **Settings → Sharing**, any signed-in user can share items they can fully access (a Family user can't share a folder with a denied sub-folder inside it). The Owner can see and delete everyone's links, and turning sharing off disables every link at once.

## Devices and apps

**Devices** (in the sidebar and the user menu) lists the [Loom apps](APPS.md) signed in to your account: their name, app version and when they were last active. Rename or remove them there; removing one signs it out at once.

To add a phone or tablet, choose **Show pairing code** and scan the QR code from the app (or type the code). The code works once and expires after 10 minutes. On Windows, choose **Sign in** in the app instead: it opens Loom and asks you to allow it, after checking the code both show.

The Owner sees everyone's devices and can remove any of them.

## Trash

Deleted items stay in Trash for 15 days, then they're deleted for good. From Trash you can:

- **Restore** an item to where it was. If the original folder no longer exists, it's recreated.
- **Restore to…** a different folder.
- **Delete forever.**

If something already exists at the original location, Loom asks what to do (Keep both or Replace) for every conflict, not just the first. Family users see and restore only what they deleted themselves; the Owner sees everything.

## Details and storage

The sliders button in the toolbar (or Alt + Enter) opens the details panel: size, location, dates, the camera and date taken for photos, resolution and codecs for videos, the GPS location (linked to OpenStreetMap), file health, and recent activity.

The storage meter at the bottom of the sidebar shows how full the drive is. The Owner gets a breakdown by type in **Settings → Storage**.

## For the Owner

| Where | What it does |
|---|---|
| Settings → Users | Create accounts and change roles and passwords. Nobody can sign up on their own. The last Owner can't be demoted or deleted. |
| Settings → Permissions | Restrict Family users to certain folders. For example, deny `/` and allow `Photos` to limit someone to one folder. |
| Settings → Scanner | Scan Now picks up files added or changed outside Loom. Also shows background processing, recent jobs, and the thumbnail and video caches. |
| Settings → Sharing | Turn share links on or off for everyone, and see or delete every link. |
| Settings → Storage | Drive usage, a breakdown of the library by type, and space used by unfinished uploads (with Clean up). |
| Settings → Audit Log | Every change, who made it, and when. |
| File Health (sidebar) | Files that look damaged or that Loom can't preview, with Check again. |
