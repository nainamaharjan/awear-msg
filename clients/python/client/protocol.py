"""Wire protocol: HTTP calls and message (de)serialization.

Implements the three endpoints from ``spec/protocol.md`` using only the standard
library (``urllib.request`` + ``json``), as required by ``spec/platform/python.md``.

The single responsibility of this module is to turn protocol intent into HTTP and
back. It deliberately knows nothing about the offline state machine (that lives in
``core.py``) or persistence (``store.py``).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

PROTOCOL_VERSION = "1"

# Max body size from protocol.md §3 (the message `body` field).
MAX_BODY_BYTES = 4096


class NetworkError(Exception):
    """The server was unreachable (connection refused, timeout, DNS, etc.).

    Per behavior.md §2 this is the signal to transition the client to OFFLINE.
    It is distinct from a reachable-server error response (see ProtocolError).
    """


class ProtocolError(Exception):
    """The server was reachable but returned a non-2xx response.

    Carries the HTTP status and the parsed error envelope (protocol.md §6). This
    does NOT imply offline — the server answered (behavior.md §3.2 step 4).
    """

    def __init__(self, status: int, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.status = status
        self.code = code
        self.detail = detail


def now_iso() -> str:
    """RFC 3339 / ISO 8601 UTC timestamp for a message's ``sent_at``."""
    return datetime.now(timezone.utc).isoformat()


class Server:
    """Thin HTTP client bound to a single server base URL."""

    def __init__(self, base_url: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # --- low-level request -------------------------------------------------
    def _request(
        self, method: str, path: str, body: Optional[Dict[str, Any]] = None
    ) -> Tuple[int, Dict[str, Any]]:
        url = f"{self.base_url}{path}"
        data = None
        headers = {"X-Protocol-Version": PROTOCOL_VERSION}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                payload = json.loads(raw) if raw else {}
                return resp.status, payload
        except urllib.error.HTTPError as exc:
            # The server responded with a non-2xx status: reachable, so this is a
            # ProtocolError, not a NetworkError.
            raw = exc.read().decode("utf-8") if exc.fp else ""
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {}
            code = payload.get("error", "http_error")
            detail = payload.get("detail", f"HTTP {exc.code}")
            raise ProtocolError(exc.code, code, detail) from exc
        except urllib.error.URLError as exc:
            # No HTTP response at all (refused, timeout, DNS): the server is
            # unreachable -> OFFLINE transition (behavior.md §2).
            raise NetworkError(str(exc.reason)) from exc
        except (TimeoutError, ConnectionError, OSError) as exc:
            raise NetworkError(str(exc)) from exc

    # --- endpoints (protocol.md §4) ---------------------------------------
    def login(self, name: str) -> Dict[str, Any]:
        """POST /session — idempotent login by name (protocol.md §4.1)."""
        _, payload = self._request("POST", "/session", {"name": name})
        return payload

    def send(self, message: Dict[str, Any]) -> Tuple[bool, int]:
        """POST /messages — send one message (protocol.md §4.2).

        Returns ``(delivered, delivery_seq)``. ``delivered`` is True for both a
        ``202 accepted`` and a ``200 duplicate`` — both mean the server holds the
        message, so the outbox entry can be dropped (behavior.md §3.2 step 2).
        """
        status, payload = self._request("POST", "/messages", message)
        # 202 accepted or 200 duplicate — both are success for flush purposes.
        return True, int(payload.get("delivery_seq", 0))

    def fetch(self, user: str, after: int) -> Tuple[List[Dict[str, Any]], int]:
        """GET /messages — poll for messages after a cursor (protocol.md §4.3)."""
        path = f"/messages?user={urllib.parse.quote(user)}&after={int(after)}"
        _, payload = self._request("GET", path)
        messages = payload.get("messages", [])
        cursor = int(payload.get("cursor", after))
        return messages, cursor
