# Using Loom

A quick tour of what you can do once Loom is running.

## Uploading

Drag files, or whole folders, onto any folder view. You can also use New → Upload files / Upload folder, or drop files straight onto a folder tile to upload into it.

- Progress. The upload panel in the corner shows progress, speed, and time remaining.
- Done means stored. A file shows as Uploaded as soon as every byte is safely stored. Its thumbnail appears a few seconds later ("preview generating in background").
- Interruptions. If your connection drops, uploads retry on their own. If you close the tab, choose the same files again within 24 hours to resume where they stopped.
- Name clashes. An upload never overwrites anything. If a file with the same name exists, the new one becomes `name (1).ext`.
- Minimizing. You can hide the panel. A small pill keeps showing progress, and clicking it brings the panel back.

## Selecting and organizing

- Selecting. Click the circle on a tile, Ctrl/Cmd-click, or Shift-click for a range. On a phone, long-press. Once something is selected, taps add or remove items.
- Bulk actions. With items selected, the bar at the top can Download (as a ZIP), Move to, Copy to, Star, or Trash them.
- Right-click or ⋮ on anything for every action: open, download, rename, move, copy, cut/copy/paste, star, pin to the sidebar, details, and move to Trash.
- Dragging. Drag items onto a folder, a breadcrumb, a pinned folder, or All Files to move them. Hold Alt or Ctrl to copy instead.
- Name clashes when moving or copying. Loom asks whether to keep both, replace, or skip. Replace moves the existing item to Trash, so it can still be restored.
- Undo. Most actions show an Undo button for a few seconds.

## Keyboard shortcuts

- Arrow keys: Move between items (Shift extends the selection)
- Enter: Open
- Alt + Enter: Show details
- Space: Select / deselect
- Ctrl/Cmd + A: Select all
- Ctrl/Cmd + C, X, V: Copy, cut, paste
- F2: Rename
- Delete (or Cmd + Backspace): Move to Trash
- Esc: Clear the selection
- /: Search
- ← → (in the viewer): Previous / next
- i (in the viewer): Details
- Ctrl/Cmd + S (in the editor): Save

## Viewing and editing

Click a file to open the viewer.

- Photos. They load a fast preview first; Original loads the full file. Zoom with the scroll wheel, a pinch, or a double-click, and drag to pan. There's also a slideshow.
- Videos. They play right away. Formats your browser can't play natively are converted on the fly, and you can seek anywhere.
- Audio. It plays with auto-advance to the next track.
- PDFs. They open in your browser's PDF viewer.
- Text, code, and Markdown. They open highlighted, and Markdown is rendered. Click Edit, then Save (or Ctrl/Cmd + S). If the file changed on disk while you were editing, Loom asks before overwriting. The previous version is kept in Trash for 15 days either way.

New → New text file creates a file and opens it in the editor.

## Search, sorting, and filters

- Search. It covers the current folder and its sub-folders. The globe button searches your whole library. Exact and prefix matches come first.
- Sorting. The sort button in the toolbar sorts by name, date, size, or type. In list view you can also click the column headers.
- Filters. The chips in the toolbar (Photos, Videos, Audio, Documents, Folders) filter what you see.
- Library-wide views. The Photos, Videos, Audio, Documents, Starred, and Recent views in the sidebar cover your whole library.

## Share links

Right-click a file or folder and choose Share link… to create a link anyone can open without an account.

- Options. Give the link an expiry (1 day to never), a password, and choose whether visitors can download. The link is copied as soon as it's created.
- Visitors. Visitors can browse a shared folder, preview its photos, videos, audio, and PDFs, and download files or everything as a ZIP (if allowed).
- Managing links. Shared links in the sidebar lists the links you've made. Delete one there and it stops working immediately. Links keep working if the item is renamed or moved, and pause while it's in Trash.
- Sharing is off by default. The Owner turns it on in Settings → Sharing, where they can also see and delete everyone's links, or turn sharing off to disable them all at once.

## Trash

Deleted items stay in Trash for 15 days. From there you can:

- Restore them to where they were.
- Restore to… a different folder.
- Delete forever.

If something already exists at the original location, Loom asks what to do. Previous versions saved by the text editor appear in Trash marked "previous version".

## Details and storage

The sliders button in the toolbar (or Alt + Enter) opens the details panel. It shows size, location, dates, the camera and date taken for photos, the resolution and codecs for videos, GPS location (a link to OpenStreetMap), and recent activity.

The storage meter at the bottom of the sidebar shows how full your drive is. Owners can see a breakdown by type in Settings, under Storage.

## For the Owner

- Settings → Users. Create accounts. Nobody can sign up on their own.
- Settings → Permissions. Limit Family users to certain folders. For example, deny `/` and allow `Photos`.
- Settings → Scanner. Pick up files you added or changed outside Loom. It also shows background processing and the caches.
- Settings → Sharing. Allow or block public share links, and manage all links.
- Settings → Storage. Drive usage and a breakdown of your library by type.
- Settings → Audit Log. See every change, who made it, and when.
- File Health. Lists files that look damaged or that Loom can't preview.
