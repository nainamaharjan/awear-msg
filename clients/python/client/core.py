"""Client state machine: send / flush / poll / reconnect (behavior.md §3).

`Client` operates on an in-memory copy of the persisted state dict. Each control
command mutates the state; the caller (`__main__`) persists once at the end of the
command. Because each invocation runs exactly one command in its own process
(control-interface.md §1), a single atomic save at the end preserves the no-loss
invariant: either the whole command's effect is durable or none of it is. If the
process dies after a successful POST but before the save, the message is still in
the outbox and will be re-sent next run; the server dedups on `id` (protocol.md
§4.2), so it is neither lost nor displayed twice.

Connectivity is a persisted flag that gates all network I/O (behavior.md §2). A
network error during any request flips the flag to OFFLINE.
"""

import uuid
from datetime import datetime, timezone

from . import protocol


class Client:
    def __init__(self, state, server):
        self.state = state
        # protocol.md §1: base URL supplied at startup; tolerate a trailing slash.
        self.server = server.rstrip("/") if server else server

    # --- connectivity ----------------------------------------------------
    @property
    def online(self):
        return bool(self.state["online"])

    def _go_offline(self):
        self.state["online"] = False

    # --- login (control-interface.md §4.1) -------------------------------
    def login(self, name):
        self.state["identity"] = name
        if self.online:
            try:
                protocol.post_session(self.server, name)
                # Any successful request implies ONLINE; nothing else to do.
            except protocol.NetworkError:
                self._go_offline()
        return {"ok": True, "user": name}

    # --- send (control-interface.md §4.2, behavior.md §3.1) --------------
    def send(self, to, body):
        message = {
            "id": str(uuid.uuid4()),
            "from": self.state["identity"],
            "to": to,
            "body": body,
            "sent_at": datetime.now(timezone.utc).isoformat(),
        }
        # Enqueue first — this is what guarantees no loss when offline.
        self.state["outbox"].append(message)

        if self.online:
            self.flush()

        still_queued = any(m["id"] == message["id"] for m in self.state["outbox"])
        return {
            "ok": True,
            "id": message["id"],
            "sent": not still_queued,
            "queued_remaining": len(self.state["outbox"]),
        }

    # --- flush (control-interface.md §4.3, behavior.md §3.2) -------------
    def flush(self):
        """Drain the outbox oldest-first. Returns the count flushed this call."""
        flushed = 0
        if not self.online:
            # OFFLINE gates network I/O; nothing leaves the outbox.
            return flushed

        while self.state["outbox"]:
            message = self.state["outbox"][0]
            try:
                status, payload = protocol.post_message(self.server, message)
            except protocol.NetworkError:
                # behavior.md §3.2 step 3: go OFFLINE and stop; order preserved.
                self._go_offline()
                break

            ack = payload.get("status")
            if status in (202, 200) and ack in ("accepted", "duplicate"):
                # accepted or duplicate both mean "the server has it" -> drop it.
                self.state["outbox"].pop(0)
                flushed += 1
            else:
                # behavior.md §3.2 step 4: reachable but rejected. Keep the
                # message, stay ONLINE, stop the flush. (Should not happen for
                # well-formed messages.)
                break
        return flushed

    # --- poll (control-interface.md §4.4, behavior.md §3.3) -------------
    def poll(self):
        """Fetch new messages, display (dedup), advance cursor.

        Returns the list of newly displayed messages in delivery_seq order.
        """
        received = []
        if not self.online:
            return received  # poll only runs while ONLINE (behavior.md §3.3)

        try:
            status, payload = protocol.get_messages(
                self.server, self.state["identity"], self.state["cursor"]
            )
        except protocol.NetworkError:
            self._go_offline()
            return received

        if status != 200:
            # Reachable but errored; leave cursor untouched and surface nothing.
            return received

        displayed = set(self.state["displayed_ids"])
        messages = sorted(
            payload.get("messages", []), key=lambda m: m.get("delivery_seq", 0)
        )
        for m in messages:
            mid = m.get("id")
            if mid not in displayed:
                received.append({
                    "id": mid,
                    "from": m.get("from"),
                    "body": m.get("body"),
                    "delivery_seq": m.get("delivery_seq"),
                })
                displayed.add(mid)

        self.state["cursor"] = payload.get("cursor", self.state["cursor"])
        self.state["displayed_ids"] = list(displayed)
        return received

    # --- set-online (control-interface.md §4.5, behavior.md §3.4) -------
    def set_online(self, value):
        was_online = self.online
        self.state["online"] = value

        flushed = 0
        received = []
        if value and not was_online:
            # Genuine OFFLINE -> ONLINE transition: reconnect = flush then poll.
            flushed = self.flush()
            received = self.poll()

        return {
            "ok": True,
            # Report the actual flag: flush/poll may have flipped it back to
            # OFFLINE if the server turned out to be unreachable.
            "online": self.online,
            "flushed": flushed,
            "received": received,
        }

    # --- dump-state (control-interface.md §4.6) -------------------------
    def dump_state(self):
        return {
            "ok": True,
            "identity": self.state["identity"],
            "online": self.online,
            "outbox": [
                {"id": m["id"], "to": m["to"], "body": m["body"]}
                for m in self.state["outbox"]
            ],
            "cursor": self.state["cursor"],
            "displayed_ids": list(self.state["displayed_ids"]),
        }
