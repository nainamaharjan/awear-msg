#!/usr/bin/env python3
"""Trivial in-memory messaging server.

Implements exactly the three endpoints defined in
spec/protocol.md. In-memory only: no persistence, no auth, single process.

Run:  python server/app.py [--host 127.0.0.1] [--port 8000]
"""

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PROTOCOL_VERSION = "1"


class State:
    """All server state, guarded by a lock (clients are separate processes)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.seq = 0                 # monotonic delivery_seq counter
        self.messages = []           # list of stored message dicts (with delivery_seq)
        self.seen = {}               # message id -> delivery_seq (idempotency)
        self.users = set()           # known user names

    def login(self, name):
        with self.lock:
            self.users.add(name)
        return {"user": name}

    def send(self, msg):
        with self.lock:
            mid = msg["id"]
            if mid in self.seen:                       # idempotent: already accepted
                return 200, {"status": "duplicate", "id": mid,
                             "delivery_seq": self.seen[mid]}
            self.seq += 1
            stored = {
                "id": mid,
                "from": msg["from"],
                "to": msg["to"],
                "body": msg["body"],
                "sent_at": msg["sent_at"],
                "delivery_seq": self.seq,
            }
            self.messages.append(stored)
            self.seen[mid] = self.seq
            return 202, {"status": "accepted", "id": mid, "delivery_seq": self.seq}

    def fetch(self, user, after):
        with self.lock:
            out = [m for m in self.messages
                   if m["to"] == user and m["delivery_seq"] > after]
        out.sort(key=lambda m: m["delivery_seq"])
        cursor = out[-1]["delivery_seq"] if out else after
        return {"messages": out, "cursor": cursor}


STATE = State()
REQUIRED_FIELDS = ("id", "from", "to", "body", "sent_at")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # --- helpers ----------------------------------------------------------
    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, code, detail):
        self._json(status, {"error": code, "detail": detail})

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _check_version(self):
        v = self.headers.get("X-Protocol-Version")
        if v is not None and v != PROTOCOL_VERSION:
            self._error(400, "unsupported_version", f"need version {PROTOCOL_VERSION}")
            return False
        return True

    def log_message(self, *args):    # silence default stderr logging
        pass

    # --- routes -----------------------------------------------------------
    def do_POST(self):
        if not self._check_version():
            return
        path = urlparse(self.path).path
        try:
            body = self._read_body()
        except (ValueError, json.JSONDecodeError):
            return self._error(400, "bad_json", "request body is not valid JSON")

        if path == "/session":
            name = body.get("name", "")
            if not isinstance(name, str) or not name.strip():
                return self._error(400, "bad_name", "name must be a non-empty string")
            return self._json(200, STATE.login(name))

        if path == "/messages":
            missing = [f for f in REQUIRED_FIELDS if not body.get(f)]
            if missing:
                return self._error(400, "missing_fields",
                                   f"missing/empty: {', '.join(missing)}")
            status, payload = STATE.send(body)
            return self._json(status, payload)

        self._error(404, "not_found", f"no such route: {path}")

    def do_GET(self):
        if not self._check_version():
            return
        parsed = urlparse(self.path)
        if parsed.path != "/messages":
            return self._error(404, "not_found", f"no such route: {parsed.path}")
        q = parse_qs(parsed.query)
        user = (q.get("user") or [""])[0]
        if not user:
            return self._error(400, "missing_user", "query param 'user' is required")
        try:
            after = int((q.get("after") or ["0"])[0])
        except ValueError:
            return self._error(400, "bad_after", "'after' must be an integer")
        return self._json(200, STATE.fetch(user, after))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"messaging server listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()