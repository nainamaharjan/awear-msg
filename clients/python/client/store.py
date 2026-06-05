"""Persistent client state (behavior.md §1).

The ``--store`` path is a single JSON file holding the four pieces of state that
MUST survive process restart, plus the persisted connectivity flag (the one-shot
execution model means connectivity is state, not an in-memory flag —
control-interface.md §1):

    identity      : str | None     logged-in user name
    online        : bool           persisted connectivity flag
    outbox        : list[message]  composed-but-unacknowledged, FIFO oldest-first
    cursor        : int            highest delivery_seq fetched/displayed
    displayed_ids : list[str]      ids already shown (display-dedup safety net)

Saves are atomic (write temp file in the same dir, then ``os.replace``) so a crash
mid-write cannot corrupt the store (spec/platform/python.md).
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any, Dict, List, Optional


class Store:
    def __init__(self, path: str):
        self.path = path
        self.identity: Optional[str] = None
        # Default connectivity is ONLINE: a fresh client assumes the server is
        # reachable and discovers OFFLINE on the first network error (behavior.md
        # §2). The scenario's first commands run online without an explicit
        # set-online true.
        self.online: bool = True
        self.outbox: List[Dict[str, Any]] = []
        self.cursor: int = 0
        self.displayed_ids: List[str] = []
        self._load()

    def _load(self) -> None:
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, OSError):
            # A missing or unreadable store is treated as empty/fresh. We do not
            # crash the command over a corrupt store; the spec's atomic writes
            # make corruption unlikely in the first place.
            return
        self.identity = data.get("identity")
        self.online = bool(data.get("online", True))
        self.outbox = list(data.get("outbox", []))
        self.cursor = int(data.get("cursor", 0))
        self.displayed_ids = list(data.get("displayed_ids", []))

    def save(self) -> None:
        """Atomically persist the current state to ``self.path``."""
        data = {
            "identity": self.identity,
            "online": self.online,
            "outbox": self.outbox,
            "cursor": self.cursor,
            "displayed_ids": self.displayed_ids,
        }
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".store-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            # Best-effort cleanup of the temp file on any failure.
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
