"""CLI entrypoint: argument parsing + one-shot command dispatch.

Launch string (spec/platform/python.md): `python -m client`.

Execution model (control-interface.md §1): load state from `--store`, run exactly
one command, persist, print exactly one JSON object as the final stdout line, exit
0 on success / non-zero on failure. Any unhandled error is still reported as a
structured `internal_error` rather than a crashing stack trace.
"""

import argparse
import json
import os
import sys

from . import store
from .core import Client

# Commands that require an established identity (control-interface.md §4).
_NEEDS_IDENTITY = {"send", "flush", "poll", "set-online"}
# Commands that contact the server and therefore need --server.
_NEEDS_SERVER = {"login", "send", "flush", "poll", "set-online"}


def _emit(payload, exit_code):
    """Print the single final JSON line and exit."""
    print(json.dumps(payload))
    sys.exit(exit_code)


def _fail(code, detail, exit_code=1):
    _emit({"ok": False, "error": code, "detail": detail}, exit_code)


def _parse_bool(value):
    low = str(value).strip().lower()
    if low in ("true", "1", "yes", "on"):
        return True
    if low in ("false", "0", "no", "off"):
        return False
    raise ValueError(f"expected true/false, got {value!r}")


def build_parser():
    parser = argparse.ArgumentParser(prog="client", add_help=True)
    parser.add_argument("--server", default=os.environ.get("MSG_SERVER"))
    parser.add_argument("--store", default=os.environ.get("MSG_STORE"))
    parser.add_argument("command")
    parser.add_argument("args", nargs="*")
    return parser


def dispatch(command, args, client):
    if command == "login":
        if len(args) != 1:
            return None, ("bad_args", "login requires exactly one argument: <name>")
        return client.login(args[0]), None

    if command == "send":
        if len(args) != 2:
            return None, ("bad_args", "send requires two arguments: <to> <body>")
        return client.send(args[0], args[1]), None

    if command == "flush":
        result = client.flush()
        return {"ok": True, "flushed": result,
                "remaining": len(client.state["outbox"])}, None

    if command == "poll":
        received = client.poll()
        return {"ok": True, "received": received,
                "cursor": client.state["cursor"]}, None

    if command == "set-online":
        if len(args) != 1:
            return None, ("bad_args", "set-online requires one argument: <true|false>")
        try:
            value = _parse_bool(args[0])
        except ValueError as exc:
            return None, ("bad_args", str(exc))
        return client.set_online(value), None

    if command == "dump-state":
        return client.dump_state(), None

    return None, ("unknown_command", f"no such command: {command}")


def main(argv=None):
    parser = build_parser()
    try:
        ns = parser.parse_args(argv)
    except SystemExit:
        # argparse already wrote usage to stderr; emit a structured final line.
        _fail("bad_args", "could not parse arguments", exit_code=2)

    command = ns.command

    if not ns.store:
        _fail("no_store", "--store <path> is required (or set MSG_STORE)")

    if command in _NEEDS_SERVER and not ns.server:
        _fail("no_server", f"--server <url> is required for '{command}' (or set MSG_SERVER)")

    try:
        state = store.load(ns.store)
    except (OSError, ValueError) as exc:
        _fail("store_error", f"could not read store: {exc}")

    # Identity precondition (control-interface.md §4).
    if command in _NEEDS_IDENTITY and not state.get("identity"):
        _fail("no_identity", f"'{command}' requires an established identity; run login first")

    client = Client(state, ns.server)

    try:
        result, err = dispatch(command, ns.args, client)
    except Exception as exc:  # noqa: BLE001 - last-resort structured failure
        _fail("internal_error", f"{type(exc).__name__}: {exc}")

    if err is not None:
        code, detail = err
        # No persistence on a usage error: state was not meaningfully changed.
        _fail(code, detail)

    # Persist all state changes before printing (control-interface.md §5).
    try:
        store.save(ns.store, client.state)
    except OSError as exc:
        _fail("store_error", f"could not write store: {exc}")

    _emit(result, 0)


if __name__ == "__main__":
    main()
