"""Wire protocol: HTTP calls and message (de)serialization.

Implements the three endpoints from `spec/protocol.md` using only the standard
library (`urllib`). Every request carries `X-Protocol-Version: 1`.

Two failure modes are distinguished, because `behavior.md` treats them
differently:

* `NetworkError` — the server is unreachable (connection refused, DNS, timeout).
  Callers transition to OFFLINE (behavior.md §2).
* an HTTP non-2xx response — the server is reachable but rejected the request.
  This is returned as a normal `(status, payload)` tuple so the caller can apply
  the protocol-error handling of behavior.md §3.2 step 4 (do not go offline).
"""

import json
import urllib.error
import urllib.request
from urllib.parse import urlencode

PROTOCOL_VERSION = "1"
_TIMEOUT = 10  # seconds; a hung connection becomes a NetworkError -> OFFLINE


class NetworkError(Exception):
    """Server unreachable. Triggers the OFFLINE transition (behavior.md §2)."""


def _request(method, url, body=None):
    headers = {"X-Protocol-Version": PROTOCOL_VERSION}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return resp.status, _decode(resp.read())
    except urllib.error.HTTPError as exc:
        # Server answered with a non-2xx status: reachable, but rejected us.
        return exc.code, _decode(exc.read())
    except urllib.error.URLError as exc:
        raise NetworkError(str(getattr(exc, "reason", exc))) from exc
    except (TimeoutError, OSError) as exc:  # pragma: no cover - defensive
        raise NetworkError(str(exc)) from exc


def _decode(raw):
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}


def post_session(server, name):
    """POST /session — log in by name (protocol.md §4.1)."""
    return _request("POST", f"{server}/session", {"name": name})


def post_message(server, message):
    """POST /messages — send one message (protocol.md §4.2).

    `message` must already carry id/from/to/body/sent_at (no delivery_seq).
    """
    return _request("POST", f"{server}/messages", message)


def get_messages(server, user, after):
    """GET /messages — poll for messages addressed to `user` (protocol.md §4.3)."""
    query = urlencode({"user": user, "after": after})
    return _request("GET", f"{server}/messages?{query}")
