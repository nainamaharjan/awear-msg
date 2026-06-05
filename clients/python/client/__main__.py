"""CLI entry point: argument parsing and command dispatch.

Realizes the control interface (control-interface.md). Launch string:
``python -m client`` (spec/platform/python.md). One command per process; the final
line of stdout is exactly one JSON object; exit 0 on success, non-zero on failure.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List

from . import protocol
from .core import Client, NoIdentityError
from .store import Store


def _emit(payload: Dict[str, Any], exit_code: int) -> None:
    """Print the single JSON result line and exit with the given code."""
    print(json.dumps(payload))
    sys.exit(exit_code)


def _fail(code: str, detail: str, exit_code: int = 1) -> None:
    _emit({"ok": False, "error": code, "detail": detail}, exit_code)


def _received_view(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Project messages to the `received` shape (control-interface.md §4.4)."""
    return [
        {
            "id": m["id"],
            "from": m["from"],
            "body": m["body"],
            "delivery_seq": m["delivery_seq"],
        }
        for m in messages
    ]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="client", add_help=True)
    parser.add_argument("--server", default=os.environ.get("MSG_SERVER"))
    parser.add_argument("--store", default=os.environ.get("MSG_STORE"))

    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("login").add_argument("name")

    p_send = sub.add_parser("send")
    p_send.add_argument("to")
    p_send.add_argument("body")

    sub.add_parser("flush")
    sub.add_parser("poll")
    sub.add_parser("set-online").add_argument("flag")
    sub.add_parser("dump-state")
    return parser


def _parse_bool(flag: str) -> bool:
    value = flag.strip().lower()
    if value in ("true", "1", "yes", "on"):
        return True
    if value in ("false", "0", "no", "off"):
        return False
    raise ValueError(f"expected true/false, got {flag!r}")


def dispatch(args: argparse.Namespace) -> None:
    if not args.store:
        _fail("bad_args", "--store is required (or set MSG_STORE)", 2)

    # dump-state is purely local and does not contact the server, so --server is
    # optional for it only (control-interface.md §4.6). Every other command needs
    # a server URL.
    if args.command != "dump-state" and not args.server:
        _fail("bad_args", "--server is required (or set MSG_SERVER)", 2)

    store = Store(args.store)
    server = protocol.Server(args.server) if args.server else None
    client = Client(store, server)

    command = args.command

    if command == "login":
        name = client.login(args.name)
        _emit({"ok": True, "user": name}, 0)

    if command == "send":
        msg_id, sent, remaining = client.send(args.to, args.body)
        _emit({"ok": True, "id": msg_id, "sent": sent,
               "queued_remaining": remaining}, 0)

    if command == "flush":
        flushed = client.flush()
        _emit({"ok": True, "flushed": flushed,
               "remaining": len(store.outbox)}, 0)

    if command == "poll":
        received = client.poll()
        _emit({"ok": True, "received": _received_view(received),
               "cursor": store.cursor}, 0)

    if command == "set-online":
        try:
            online = _parse_bool(args.flag)
        except ValueError as exc:
            _fail("bad_args", str(exc), 2)
        flushed, received = client.set_online(online)
        _emit({"ok": True, "online": online, "flushed": flushed,
               "received": _received_view(received)}, 0)

    if command == "dump-state":
        outbox_view = [
            {"id": m["id"], "to": m["to"], "body": m["body"]}
            for m in store.outbox
        ]
        _emit({
            "ok": True,
            "identity": store.identity,
            "online": store.online,
            "outbox": outbox_view,
            "cursor": store.cursor,
            "displayed_ids": list(store.displayed_ids),
        }, 0)

    # Unknown command should be impossible (argparse enforces choices).
    _fail("bad_args", f"unknown command: {command}", 2)


def main(argv: List[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        dispatch(args)
    except SystemExit:
        raise  # _emit/_fail already produced the structured line.
    except NoIdentityError as exc:
        _fail("no_identity", str(exc), 1)
    except protocol.ProtocolError as exc:
        # Server reachable but rejected the request (protocol.md §6).
        _fail(exc.code, exc.detail, 1)
    except protocol.NetworkError as exc:
        # Should normally be caught and turned into an OFFLINE transition inside
        # core; surfacing here is a defensive backstop.
        _fail("network_error", str(exc), 1)
    except Exception as exc:  # noqa: BLE001 — control-interface.md §3 backstop.
        _fail("internal_error", f"{type(exc).__name__}: {exc}", 1)


if __name__ == "__main__":
    main()
