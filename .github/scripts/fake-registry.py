#!/usr/bin/env python3
"""Minimal stand-in for an npm registry that never serves anything.

Every request is appended to a log file as "METHOD PATH" and answered with
HTTP 503. The workflow uses it to prove that a package manager really sends
its requests to the configured registry, and that the install fails when
that registry does not deliver packages.

Usage: fake-registry.py [port] [logfile]
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4873
LOG = sys.argv[2] if len(sys.argv) > 2 else "fake-registry.log"


class Handler(BaseHTTPRequestHandler):
    def _handle(self):
        with open(LOG, "a") as f:
            f.write(f"{self.command} {self.path}\n")
        body = json.dumps({"error": "fake registry: nothing is served here"}).encode()
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_HEAD = _handle

    def log_message(self, fmt, *args):
        sys.stderr.write(f"fake-registry: {self.command} {self.path}\n")


if __name__ == "__main__":
    print(f"fake registry listening on http://127.0.0.1:{PORT}, logging to {LOG}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
