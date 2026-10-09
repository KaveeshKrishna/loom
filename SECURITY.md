# Security Policy

Loom manages access to your personal files, so please report vulnerabilities privately rather than through a public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

1. Go to the **Security** tab of the repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version or commit, and steps to reproduce if possible.

This opens a private conversation with the maintainer that isn't visible publicly until it's resolved.

Please include, where relevant:

- the affected component (`web`, `scanner`, path validation, permissions, auth, share links, the scripts…);
- steps to reproduce, or a minimal proof of concept;
- the potential impact, for example reading files outside the media root, a Family user gaining Owner access, signing in without valid credentials, or reaching files outside a share link's folder.

## Scope

**In scope:** the code in this repository as shipped: `web/`, `scanner/`, the scripts in `scripts/`, the Dockerfiles and `compose.yml`.

**Out of scope:**

- vulnerabilities in third-party dependencies (report those upstream; feel free to also flag them here if Loom's usage makes the impact worse than typical);
- issues that only arise from a misconfigured deployment, such as exposing the container port to the internet against the guidance in [docs/REVERSE-PROXY.md](docs/REVERSE-PROXY.md);
- the public demo build (`loom-demo/`), which has no backend and only fabricated data.

## How Loom protects your files

The main defenses, so reports can be checked against the intended behavior. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the details.

- **Accounts.** Nobody can register themselves. The first account comes from the one-time setup page (which refuses once any user exists, even under concurrent requests), and after that only the Owner creates users. Roles can only be changed by the Owner; the auth library's own endpoints can't set them. The last Owner can't be demoted or deleted. Sign-in and password changes are rate-limited. loom-web refuses to start with a missing or example `BETTER_AUTH_SECRET`. Changing a password signs that user out everywhere.
- **Paths.** Every file operation validates names and paths, rejecting `..`, `/` inside names, and control characters. Permissions are checked on the normalized path, and symlinks are resolved so nothing can escape the media folder. Loom's internal folders (`.LoomTrash`, `.tmp-upload`) can't be targeted through the normal file APIs.
- **Permissions.** A Family user's rules are enforced on listing, reading, thumbnails and previews, search, favorites, uploads, downloads, share links and every change. Operations on a folder require access to everything inside it.
- **No destructive overwrites.** Replace, restore and text edits move the old version to Trash instead of destroying it. Uploads never overwrite. Disk and index changes roll back together on failure.
- **Serving files.** User files can't run scripts in Loom's origin: they get `nosniff`, a sandboxing CSP, and executable types (HTML, SVG, XML, JavaScript) are forced to download or shown as plain text. The app sends `frame-ancestors`, `Referrer-Policy` and `Permissions-Policy` headers. Markdown is rendered without raw HTML.
- **Uploads.** Uploads are verified chunk by chunk (SHA-256) and only appear in the media folder once complete.
- **Share links.** Off by default. Tokens are 32 random bytes and stored hashed. Links can have a password (bcrypt, rate-limited), an expiry and a view-only mode, and are confined to the shared item. They stop working if the item is trashed, the creator loses access, or the Owner turns sharing off. See [ARCHITECTURE.md → Share links](docs/ARCHITECTURE.md#share-links).
- **Apps and devices.** Apps authenticate with device tokens (32 random bytes, generated on the device; only the SHA-256 reaches the server). Pairing needs a signed-in user to approve the request after comparing a six-digit code, or a one-time code from the Devices page (10 minutes, single use, rate-limited). Device tokens can't do Owner administration, manage devices or create share links. Removing a device, resetting the user's password or deleting the user revokes it within 15 seconds, along with its web session. In the Windows app, Loom's page talks to the app only through WebView2's message channel, checked against the server's origin; it can hand over files the user picked or dropped, never name a local path.
- **LAN access (optional).** The LAN listener only accepts requests with a device token, refuses browser cookies, and replaces client-supplied address headers. Its certificate authority's key stays outside the media folder and out of loom-web; apps trust its certificate for the LAN address only, pinned from the normal HTTPS address.
- **Containers.** loom-web and loom-scanner run as the unprivileged `node` user (uid 1000). The scanner's entrypoint starts as root only to hand leftover root-owned cache files to that user, then drops root. It never changes anything in the media folder.
- **Install and update.** No script ever changes, moves, deletes or chowns anything in the media folder. The installer refuses a cache folder inside the media folder and asks before creating a missing media folder. `update.sh` refuses to run over local edits, backs up the database and verifies the backup before changing anything, only fast-forwards the code, builds before stopping the running version, waits for health, and can roll back. Migrations only add things, so an older version still runs on a newer database. Backups are written with mode 600. `uninstall.sh` backs up the database before deleting it.
- **Account recovery.** The only password reset is a command run on the server (`docker compose exec loom-web node scripts/reset-password.mjs`), so it requires shell access to the server.

## Supported versions

Loom doesn't maintain multiple release branches. Security fixes are made on the latest `main` and listed in [CHANGELOG.md](CHANGELOG.md). If you're on an older version, please update first (`./scripts/update.sh`) to confirm the issue still applies.

## Response expectations

This project is maintained in spare time, so please allow a reasonable window for a response. Critical issues (remote path traversal, authentication bypass, permission bypass) are prioritized.
