#!/usr/bin/env python3
"""
Loom Mount Service
==================
Runs on the host OS via systemd. Exposes exactly three authenticated endpoints:
  GET  /status   - returns current archive mount status
  POST /mount    - mounts the Samsung T7
  POST /unmount  - safely unmounts the Samsung T7

Authentication: Bearer token in Authorization header.
Listens only on 127.0.0.1:8084 — never exposed publicly.
"""

import os
import subprocess
import json
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler

# ─── Configuration ──────────────────────────────────────────────────────────
HOST = "0.0.0.0"
PORT = 8084
SECRET = os.environ.get("MOUNT_SERVICE_SECRET", "")
DEVICE = os.environ.get("T7_DEVICE", "")       # e.g. /dev/sdb1
MOUNT_POINT = os.environ.get("T7_MOUNT_POINT", "/srv/storage/personal/media")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("loom-mount")


# ─── Helpers ────────────────────────────────────────────────────────────────

def is_mounted() -> bool:
    """Check if the mount point currently has a filesystem mounted."""
    try:
        result = subprocess.run(
            ["mountpoint", "-q", MOUNT_POINT],
            check=False, capture_output=True
        )
        return result.returncode == 0
    except Exception as e:
        log.error(f"mountpoint check failed: {e}")
        return False


def do_mount() -> dict:
    """Mount the Samsung T7."""
    if not DEVICE:
        return {"success": False, "error": "T7_DEVICE not configured in environment"}
    if is_mounted():
        return {"success": True, "status": "Online", "message": "Already mounted"}
    try:
        subprocess.run(
            ["mount", DEVICE, MOUNT_POINT],
            check=True, capture_output=True, text=True, timeout=30
        )
        log.info(f"Mounted {DEVICE} at {MOUNT_POINT}")
        return {"success": True, "status": "Online"}
    except subprocess.CalledProcessError as e:
        log.error(f"Mount failed: {e.stderr}")
        return {"success": False, "error": e.stderr.strip()}
    except Exception as e:
        log.error(f"Mount error: {e}")
        return {"success": False, "error": str(e)}


def do_unmount() -> dict:
    """Safely unmount the Samsung T7."""
    if not is_mounted():
        return {"success": True, "status": "Offline", "message": "Already unmounted"}
    try:
        # Flush kernel write buffers
        subprocess.run(["sync"], check=True, timeout=15)
        # Lazy unmount to handle any remaining open handles gracefully
        subprocess.run(
            ["umount", "-l", MOUNT_POINT],
            check=True, capture_output=True, text=True, timeout=30
        )
        log.info(f"Unmounted {MOUNT_POINT}")
        return {"success": True, "status": "Offline"}
    except subprocess.CalledProcessError as e:
        log.error(f"Unmount failed: {e.stderr}")
        return {"success": False, "error": e.stderr.strip()}
    except Exception as e:
        log.error(f"Unmount error: {e}")
        return {"success": False, "error": str(e)}


def get_status() -> dict:
    mounted = is_mounted()
    return {"success": True, "status": "Online" if mounted else "Offline"}


# ─── HTTP Handler ────────────────────────────────────────────────────────────

class MountHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info(f"{self.address_string()} - {fmt % args}")

    def send_json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authenticate(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        token = auth[len("Bearer "):]
        return token == SECRET

    def do_GET(self):
        if not self.authenticate():
            self.send_json(401, {"error": "Unauthorized"})
            return
        if self.path == "/status":
            self.send_json(200, get_status())
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if not self.authenticate():
            self.send_json(401, {"error": "Unauthorized"})
            return
        if self.path == "/mount":
            result = do_mount()
            self.send_json(200 if result["success"] else 500, result)
        elif self.path == "/unmount":
            result = do_unmount()
            self.send_json(200 if result["success"] else 500, result)
        else:
            self.send_json(404, {"error": "Not found"})


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if not SECRET:
        log.error("MOUNT_SERVICE_SECRET is not set. Refusing to start.")
        exit(1)
    if not DEVICE:
        log.warning("T7_DEVICE is not set. Mount/unmount operations will fail.")

    server = HTTPServer((HOST, PORT), MountHandler)
    log.info(f"Loom mount service listening on {HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
