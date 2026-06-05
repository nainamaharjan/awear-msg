"""Client core: the offline state machine (behavior.md §3).

Wires together persistence (``store.Store``) and the wire protocol
(``protocol.Server``) to implement send / flush / poll / reconnect with the
guarantees from behavior.md §4: no loss, per-sender FIFO, exactly-once display,
at-least-once on the wire.

Each method returns plain data; turning that into the control-interface JSON is
the job of ``__main__.py``.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Tuple

from . import protocol
from .store import Store


class NoIdentityError(Exception):
    """A command requiring identity was run before ``login`` (control-interface §4)."""


class Client:
    def __init__(self, store: Store, server: protocol.Server):
        self.store = store
        self.server = server

    # --- helpers -----------------------------------------------------------
    def _require_identity(self) -> str:
        if not self.store.identity:
            raise NoIdentityError("no identity established; run `login` first")
        return self.store.identity

    # --- commands ----------------------------------------------------------
    def login(self, name: str) -> str:
        """Set identity; if ONLINE, register with the server (control-interface §4.1).

        Login is idempotent server-side (protocol.md §4.1). A network failure here
        is not fatal: identity is local first, so we still persist it and fall to
        OFFLINE, matching the "never block on connectivity" spirit of behavior.md.
        """
        self.store.identity = name
        if self.store.online:
            try:
                self.server.login(name)
            except protocol.NetworkError:
                self.store.online = False
            # A ProtocolError on login (e.g. bad name) propagates: the server is
            # reachable and actively rejecting, which the caller should surface.
        self.store.save()
        return name

    def send(self, to: str, body: str) -> Tuple[str, bool, int]:
        """Compose + enqueue, flushing if ONLINE (behavior.md §3.1).

        Returns ``(id, sent, queued_remaining)``. ``send`` never blocks on or fails
        due to connectivity: the message is persisted to the outbox first, so it is
        never lost.
        """
        identity = self._require_identity()
        message = {
            "id": str(uuid.uuid4()),
            "from": identity,
            "to": to,
            "body": body,
            "sent_at": protocol.now_iso(),
        }
        # Persist to the outbox BEFORE any network I/O (behavior.md §3.1 step 2).
        self.store.outbox.append(message)
        self.store.save()

        sent = False
        if self.store.online:
            self.flush()
            # `sent` is true iff this id is no longer queued, i.e. it reached the
            # server in this call.
            sent = not any(m["id"] == message["id"] for m in self.store.outbox)

        return message["id"], sent, len(self.store.outbox)

    def flush(self) -> int:
        """Drain the outbox oldest-first (behavior.md §3.2). Returns count flushed.

        Stops at the first network error (transition to OFFLINE) or protocol error
        (server reachable but rejecting). Resumable: later calls continue from the
        oldest remaining message.
        """
        self._require_identity()
        flushed = 0
        while self.store.outbox:
            message = self.store.outbox[0]
            try:
                self.server.send(message)
            except protocol.NetworkError:
                # Unreachable: stop, leave this and all later messages in order.
                self.store.online = False
                self.store.save()
                return flushed
            except protocol.ProtocolError:
                # Reachable but rejected: do NOT drop the message, do NOT go
                # offline. Surface by stopping the flush (behavior.md §3.2 step 4).
                self.store.save()
                raise
            # 202 accepted or 200 duplicate: drop from outbox and persist, then
            # continue to the next message.
            self.store.online = True
            self.store.outbox.pop(0)
            self.store.save()
            flushed += 1
        return flushed

    def poll(self) -> List[Dict[str, Any]]:
        """Fetch and display new messages (behavior.md §3.3).

        Returns the list of newly displayed messages in ``delivery_seq`` order.
        Only runs while ONLINE; a network error transitions to OFFLINE.
        """
        identity = self._require_identity()
        if not self.store.online:
            return []
        try:
            messages, cursor = self.server.fetch(identity, self.store.cursor)
        except protocol.NetworkError:
            self.store.online = False
            self.store.save()
            return []

        self.store.online = True
        displayed = set(self.store.displayed_ids)
        newly: List[Dict[str, Any]] = []
        for msg in sorted(messages, key=lambda m: m["delivery_seq"]):
            if msg["id"] not in displayed:
                displayed.add(msg["id"])
                self.store.displayed_ids.append(msg["id"])
                newly.append(msg)
        # Advance the cursor and persist cursor + displayed_ids together.
        self.store.cursor = cursor
        self.store.save()
        return newly

    def set_online(self, online: bool) -> Tuple[int, List[Dict[str, Any]]]:
        """Persist connectivity; on an OFFLINE->ONLINE transition, reconnect.

        Reconnect is flush-then-poll (behavior.md §3.4). Idempotent: setting to a
        value already held is a no-op and runs neither flush nor poll
        (control-interface.md §4.5). Returns ``(flushed, received)``.
        """
        self._require_identity()
        was_online = self.store.online

        if online and not was_online:
            # Actual OFFLINE -> ONLINE transition: reconnect.
            self.store.online = True
            self.store.save()
            flushed = self.flush()
            received = self.poll()
            return flushed, received

        # No transition (or going offline): just persist the flag.
        self.store.online = online
        self.store.save()
        return 0, []
