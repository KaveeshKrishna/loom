# The Loom apps

The Loom apps show your Loom in a window and add what a browser can't do: uploads and downloads that keep going with the window closed, survive a restart, and go straight to your server when you're at home.

| App | Status |
|---|---|
| Loom for Windows (10 and 11) | Available: download from the [releases](https://github.com/KaveeshKrishna/loom/releases?q=desktop&expanded=true) |
| Loom for Android (phones and tablets) | In development |

The apps need Loom 2.2 or later on the server.

## Loom for Windows

### Install and sign in

1. Download `Loom_…_x64-setup.exe` and run it. It installs for your Windows user only, without asking for administrator rights. The app isn't code-signed, so Windows may warn about an unknown publisher the first time: choose **More info**, then **Run anyway**.
2. Enter your Loom's address, e.g. `https://loom.example.com`, and a name for this PC.
3. Loom opens in a window. Sign in if it asks, check that it shows the same six-digit code as the app, and choose **Allow**.

That's it. The PC now appears in Loom under **Devices**, where you can rename it or remove it. Removing it signs the app out immediately.

### What it does

- **Loom in a window.** Everything works as in the browser. Uploads you start there (the Upload buttons, or dropping files and folders on the window) go to the app's transfer manager.
- **Transfers that don't stop.** Close the window, and Loom keeps running in the notification area (bottom right of the taskbar). Shut down or restart the PC, and unfinished transfers continue from where they were the next time Loom starts. Network trouble never fails a transfer: it waits and tries again by itself.
- **The Transfers window** (tray icon › Transfers, or the progress pill in Loom) lists every upload and download with its speed and time left. You can pause, resume, cancel or retry each one, or everything at once.
- **Upload from File Explorer.** Right-click files or folders and choose **Upload to Loom** (on Windows 11, under **Show more options**), or **Send to › Loom**. Pick the folder in Loom, and what to do if a file with the same name is already there.
- **Name conflicts** work like in Windows: Replace (the old file goes to Loom's Trash for 15 days), Skip, or Keep both (the new one gets a number), for one file or all of them.
- **Fast at home.** If your server offers LAN access (below), the app sends files straight to it over your home network instead of out to the internet and back. The Transfers window shows **Direct** when it does.
- **Downloads** go to `Downloads\Loom` (or wherever you choose in Settings), folder structure included, and also resume after interruptions.

### Settings

Settings are in the Transfers window: how many files and parts of files move at once, a speed limit, keeping the PC awake while transferring, using the home network, where downloads go, starting Loom when you sign in to Windows, and the File Explorer options. **Settings › Logs** opens the app's log folder if something goes wrong.

### Removing it

Uninstall Loom from Windows Settings › Apps. That also removes "Upload to Loom" and the Send to entry. To also sign the PC out of Loom, remove it under **Devices** in Loom (or use **Sign out** in the app first).

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
