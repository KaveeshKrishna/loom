"""A stand-in for Loom for `Loom.exe --offline-self-test` (see src-tauri/src/self_test.rs).

It starts "down": every page answers 502 like a reverse proxy whose Loom is
restarting, and /api/health answers 503. GET /__up brings it "up": pages are
loom-page.html (which talks to the app) and /api/health answers ok.

    python server.py 8124
"""

import http.server
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
state = {"up": False}


class Handler(http.server.BaseHTTPRequestHandler):
    def send(self, status, body, ctype="text/html; charset=utf-8"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/__up":
            state["up"] = True
            return self.send(200, "up", "text/plain")
        if path == "/api/health":
            body = json.dumps({"status": "ok" if state["up"] else "unavailable", "version": "test", "build": "test"})
            return self.send(200 if state["up"] else 503, body, "application/json")
        if not state["up"]:
            return self.send(502, "<h1>502 Bad Gateway</h1>")
        with open(os.path.join(HERE, "loom-page.html"), "rb") as f:
            return self.send(200, f.read())

    def log_message(self, fmt, *args):
        sys.stderr.write("server: " + (fmt % args) + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8124
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
