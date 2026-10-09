# The Loom apps

The Loom apps show your Loom in a window and add what a browser can't do: uploads and downloads that keep going with the window closed, survive a restart, and go straight to your server when you're at home.

| App | Status |
|---|---|
| Loom for Windows (10 and 11) | [Download the installer](https://github.com/KaveeshKrishna/loom/releases/download/updates/Loom-Windows-Setup.exe) |
| Loom for Android (8 and later, phones and tablets) | [Download the APK](https://github.com/KaveeshKrishna/loom/releases/download/updates/Loom-Android.apk) |

These links always give the newest version; Loom's **Devices** page has the same buttons. Release notes and earlier versions are on the [releases page](https://github.com/KaveeshKrishna/loom/releases). The apps need Loom 2.2 or later on the server.

## Loom for Windows

### Install and sign in

1. Download `Loom_…_x64-setup.exe` and run it. It installs for your Windows user only, without asking for administrator rights. The app isn't code-signed, so Windows may warn about an unknown publisher the first time: choose **More info**, then **Run anyway**.
2. Enter your Loom's address, e.g. `https://loom.example.com`, and a name for this PC.
3. Loom opens in a window, with the app's sign-in window kept in front of it. Sign in if it asks, check that the page shows the same code as the sign-in window, and choose **Allow**.

That's it. The PC now appears in Loom under **Devices**, where you can rename it or remove it. Removing it signs the app out immediately.

### What it does

- **Loom in a window.** Everything works as in the browser. Uploads you start there (**New › Upload files** or **Upload folder**, right-click › Upload, or dropping files and folders on the window) go to the app's transfer manager, and a message at the bottom of the window confirms it. Dropped files and folders are confirmed first; the app reads folders from disk itself, so even huge ones start at once.
- **When Loom is restarting or offline**, the window shows "Can't reach Loom", checks every few seconds and brings Loom back by itself, at the folder you were in. **Reload now** tries straight away, and the tray menu has **Reload Loom**.
- **This PC** in Loom's sidebar opens the app's **Transfers** (with a count of what's in progress) and **App settings**. They open in front of Loom and stay with its window. The same entries are in the menu under your name, and in the tray icon's menu.
- **Transfers that don't stop.** Close the window, and Loom keeps running in the notification area (bottom right of the taskbar). Shut down or restart the PC, and unfinished transfers continue from where they were the next time Loom starts. Network trouble never fails a transfer: it waits and tries again by itself.
- **The Transfers window** (tray icon › Transfers, or the progress pill in Loom) lists every upload and download with its speed and time left. You can pause, resume, cancel or retry each one, or everything at once. Minimizing it turns it into a small floating bar with the overall progress, which you can drag anywhere; its buttons pause or resume everything and open the full window again.
- **Upload from File Explorer.** Right-click files or folders and choose **Upload to Loom** (on Windows 11, under **Show more options**), or **Send to › Loom**. Pick the folder in Loom, and what to do if a file with the same name is already there.
- **Name conflicts** work like in Windows: Replace (the old file goes to Loom's Trash for 15 days), Skip, or Keep both (the new one gets a number), for one file or all of them.
- **Fast at home.** If your server offers LAN access (below), the app sends files straight to it over your home network instead of out to the internet and back. The Transfers window shows **Direct** when it does.
- **Downloads** go to `Downloads\Loom` (or wherever you choose in Settings), folder structure included, and also resume after interruptions. For folders and several items, right-click › **Download as ZIP** makes one ZIP file instead, saved to the same folder (a ZIP can't resume if it's interrupted).

### Settings

Settings are in the Transfers window: how many files and parts of files move at once, a speed limit, keeping the PC awake while transferring, using the home network, where downloads go, starting Loom when you sign in to Windows, the File Explorer options, and updates. **Settings › About › Logs** opens the app's log folder (`%LOCALAPPDATA%\app.loom.desktop\logs`) if something goes wrong.

### Updates

Loom for Windows (1.1 and later) updates itself from this project's GitHub releases. It checks when it starts and every 6 hours; **Settings › Updates › Check now** checks straight away. What happens next is up to you (**When an update is available**):

- **Download, then ask me** (the default): the update downloads in the background, then a notification and a bar in Transfers offer **Install now**.
- **Install when idle**: installs by itself once nothing has been transferring for a minute.
- **Only tell me**: just a notification; download and install from Settings when you like.

Installing takes a few seconds: Loom closes, updates and starts again, and unfinished transfers continue where they were. Updates are signed; the app refuses anything that isn't, and never installs an older version.

### Removing it

Uninstall Loom from Windows Settings › Apps. That also removes "Upload to Loom" and the Send to entry. To also sign the PC out of Loom, remove it under **Devices** in Loom (or use **Sign out** in the app first).

## Loom for Android

### Install and sign in

1. On your phone or tablet, open Loom's **Devices** page and choose **Loom for Android**, or use the link above. Open the downloaded `Loom-Android.apk`. The first time, Android asks you to allow installing apps from your browser.
2. Open Loom, enter your Loom's address (e.g. `loom.example.com`) and choose **Continue**.
3. Either choose **Sign in**: Loom's page opens in the app; sign in if it asks, check that it shows the same code as the bar above it, and choose **Allow**. Or choose **Use a pairing code** (or **Scan a pairing code** on the first screen): in Loom on another device, open **Devices › Show pairing code** and scan the QR code or type the code.

The phone or tablet then appears in Loom under **Devices**, where you can rename or remove it.

### What it does

- **All of Loom, made for touch.** The app shows your Loom and hands uploads and downloads to its own transfer manager. **New › Upload files** or **Upload folder** opens Android's file or folder picker; folders keep their structure.
- **Transfers that finish.** Uploads and downloads continue with the app closed and the screen off, and after a restart or a lost connection they pick up where they were; a file is never sent twice. A notification shows the progress, with **Pause** and **Resume**. On Android 14 and later this uses Android's transfer jobs, which have no time limit. The first upload asks to let Loom run in the background without battery limits: allow it for big uploads.
- **A bar under Loom** shows what's in progress; tap it for **Transfers**, where you can pause, resume, cancel or retry each transfer, see its files, and decide about files whose names are already taken (Replace, Skip or Keep both, for one or all).
- **Share › Loom** from Photos, Files or any other app: choose the folder, and the files upload in the background. Touch and hold Loom's icon for **Upload** (pick files, then the folder) and **Transfers**.
- **Tablets.** On wide screens Transfers opens beside Loom instead of over it. In split screen you can drag files from another app onto Loom: it asks first, then uploads them into the folder on screen.
- **Fast at home**, like the Windows app: with LAN access (below), transfers go straight to your server on the home network and switch back to the internet when you leave. **Wi-Fi only** in Settings makes transfers wait for Wi-Fi instead of using mobile data.
- **Downloads** go to `Download/Loom`, folder structure included, and resume after interruptions. **Download as ZIP** makes one file (it can't resume).
- **When Loom is restarting or offline**, the app shows "Can't reach Loom", checks every few seconds and comes back by itself.

### Settings and updates

Settings (under your name in Loom, or **This device** in the sidebar) has the account, how many files move at once, a speed limit, Wi-Fi only, the home network, background and notification permissions, and updates.

The app updates itself from this project's GitHub releases with the same choices as Windows: **Download automatically, ask to install** (the default), **Install automatically** (when nothing is being transferred), or **Only tell me**. It checks every 6 hours and in **Settings › Updates › Check now**. The first update asks you to allow Loom to install apps; on Android 12 and later, updates after that can install without asking. An update is only installed when it's signed with the same key as the installed app.

### Removing it

Uninstall Loom like any app. To also sign it out of Loom, remove it under **Devices** (or use **Sign out** in the app first).

## Building the apps yourself

The apps are built by GitHub Actions (`.github/workflows/desktop.yml`); a tag `desktop-v<version>` publishes a release. To build and publish your own (for example from a fork):

1. Make an updater key pair: `cd clients/desktop && npx tauri signer generate -w loom-updater.key`. Put the public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), and point `plugins.updater.endpoints` at your own repository's `releases/download/updates/windows.json`.
2. In your repository's **Settings › Secrets and variables › Actions**, add `TAURI_SIGNING_PRIVATE_KEY` (the private key file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Set the version in `src-tauri/tauri.conf.json`, `Cargo.toml` and `package.json`, describe it in `clients/desktop/CHANGELOG.md`, and push a tag `desktop-v<version>`. The workflow builds and tests the installer, checks that an installed copy updates itself to it, publishes the release and updates the `updates` release that installed apps check.

Without the signing key the workflow still builds and tests an installer, just without self-updates.

The Android app is built by `.github/workflows/android.yml` (the engine's tests against a test Loom, lint, and the app on phone and tablet emulators); a tag `android-v<version>` publishes it. For your own:

1. Make a signing key: `keytool -genkeypair -keystore loom-release.jks -alias loom -keyalg RSA -keysize 4096 -validity 10000 -dname CN=Loom`. Keep it safe: an app signed with another key can't update an installed one.
2. Add the secrets `ANDROID_KEYSTORE_BASE64` (`base64 -w0 loom-release.jks`), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
3. Point the app's update check at your repository: build with `-PloomUpdateUrl=https://github.com/<you>/loom/releases/download/updates/android.json` (or change the default in `clients/android/app/build.gradle.kts`).
4. Set the version in `clients/android/app/version.properties` (raise `versionCode` every time), describe it in `clients/android/CHANGELOG.md`, and push a tag `android-v<version>`.

To build locally you need JDK 17, Gradle 8.11 and the Android SDK: `cd clients/android && gradle :app:assembleDebug`. The engine alone builds without the SDK: `gradle -PengineOnly :engine:test` (with `LOOM_TEST_URL` set to a test Loom to run its live tests).

## LAN access (server side)

Uploads from home go through your internet connection twice when Loom is behind a tunnel or a remote proxy: out to the internet and back in. LAN access gives the apps a direct HTTPS address on your home network instead. It's optional; turn it on with:

```bash
./scripts/lan.sh enable              # detects this machine's LAN address
./scripts/lan.sh enable --host 192.168.1.20 --port 8443
./scripts/lan.sh status
./scripts/lan.sh disable
```

- It starts a small extra service (`loom-lan`) that serves Loom over HTTPS on that address, only to the apps: browsers get a short message, and there's no sign-in page on it.
- Its certificate comes from a private certificate authority the script creates once in `data/lan-pki` (back that folder up). Paired apps receive the authority's certificate over your normal HTTPS address and trust it for the LAN address only, so nothing on your network can impersonate the server.
- Give the server a fixed address in your router (a DHCP reservation), or run `enable` again after it changes. Apps pick up the new address by themselves.
- The apps check the LAN address every minute and whenever an upload stalls. Away from home they simply use your normal address.

Details are in [Configuration → LAN access](CONFIGURATION.md#lan-access-for-the-apps).
