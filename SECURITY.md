# Security

Loom controls access to your personal files, so please report security bugs privately instead of in a public issue.

## Reporting

Use GitHub's private vulnerability reporting for this repo. Go to the repo's Security tab, click Report a vulnerability, and describe the problem, which version or commit it affects, and how to reproduce it if you can. That starts a private thread with me that stays hidden until it's fixed.

If it's relevant, include which part is affected (web, scanner, path security / ACL, auth, and so on), steps to reproduce or a small proof of concept, and what the impact is. For example, reading files outside the media root, a Family user getting Owner access, logging in without valid credentials, or reaching files outside a share link's folder.

## Scope

In scope: the code in this repo (web/, scanner/, the installer scripts, the Dockerfiles and compose config) as shipped.

Out of scope: bugs in third-party dependencies, report those upstream, though feel free to flag it here too if Loom's use of it makes things worse. Also out of scope, problems that only happen because of a misconfigured setup, like exposing the container port to the internet when [docs/REVERSE-PROXY.md](docs/REVERSE-PROXY.md) says not to.

## How Loom protects your files

The main defenses, so reports can be checked against what's intended:

- **Accounts.** Nobody can register themselves. The first account comes from the one-time setup page, and after that only the Owner creates users. A user's role can never be set from the browser. Sign-in is rate-limited. loom-web refuses to start with a missing or example `BETTER_AUTH_SECRET`.
- **Paths.** Every file operation validates names and paths, rejecting `..`, `/` in names, and control characters. It checks permissions on the normalized path and resolves symlinks so nothing escapes the media folder. Loom's internal folders can't be targeted.
- **Permissions.** A Family user's rules are enforced on listing, reading, thumbnails, search, favorites, uploads, and every change. Operations on a folder require access to everything inside it.
- **No destructive overwrites.** Replace, restore, and text edits move the old version to Trash instead of destroying it. Uploads never overwrite. Disk and index changes roll back together on failure.
- **Serving files.** User files can't run scripts in Loom's origin: they get `nosniff`, a sandboxing CSP, and executable types are forced to download. The app itself sends frame-ancestors, Referrer-Policy, and Permissions-Policy headers.
- **Uploads.** Uploads are verified chunk by chunk and only appear in the media folder once complete.
- **Share links.** They're off by default. Tokens are random and stored hashed. Links can have a password (rate-limited), an expiry, and a view-only mode, and are confined to the shared item. They stop working if the item is trashed, the creator loses access, or the Owner turns sharing off. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#share-links).
- **Install and update.** Migrations are additive and preceded by a database backup. The scripts never touch the media folder.

## Versions

There's only one line of development right now. Security fixes go on the latest main. If you're on an older version, update first if you can, to check the bug is still there.

## Response time

This is a spare-time project, so give me a reasonable amount of time to reply. Serious bugs like remote path traversal or auth bypass come first.
