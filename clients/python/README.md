# Python messaging client

A spec-driven client for the local messaging app. Generated from `spec/`
(`protocol.md`, `behavior.md`, `control-interface.md`, `spec/platform/python.md`).

## Requirements

- CPython 3.11+
- **No third-party runtime dependencies** — standard library only. There is no
  build step and nothing to install.

## Run

The launch string is `python -m client`, invoked **one command per process**
from this directory (`clients/python/`):

```
python -m client --server <url> --store <path> <command> [args...]
```

- `--server <url>` — server base URL, e.g. `http://localhost:8000`
  (optional only for `dump-state`).
- `--store <path>` — this client's private JSON state file. Each user gets its
  own store; different paths share no state.
- Both may also come from `MSG_SERVER` / `MSG_STORE`; explicit flags win.

Every invocation prints exactly one JSON object as the final line of stdout and
exits `0` on success, non-zero on failure.

### Commands

| Command | Output (final stdout line) |
|---------|----------------------------|
| `login <name>` | `{"ok": true, "user": "<name>"}` |
| `send <to> <body>` | `{"ok": true, "id": "<uuid>", "sent": <bool>, "queued_remaining": <int>}` |
| `flush` | `{"ok": true, "flushed": <int>, "remaining": <int>}` |
| `poll` | `{"ok": true, "received": [...], "cursor": <int>}` |
| `set-online <true\|false>` | `{"ok": true, "online": <bool>, "flushed": <int>, "received": [...]}` |
| `dump-state` | `{"ok": true, "identity": ..., "online": ..., "outbox": [...], "cursor": <int>, "displayed_ids": [...]}` |

Errors produce `{"ok": false, "error": "<code>", "detail": "<text>"}` and a
non-zero exit code.

## Example

```bash
# from the repo root, start the server:
python server/app.py --port 8000 &

cd clients/python
python -m client --server http://localhost:8000 --store /tmp/alice.json login alice
python -m client --server http://localhost:8000 --store /tmp/alice.json send bob "hi"

# go offline, queue a message, then reconnect (flush + poll):
python -m client --server http://localhost:8000 --store /tmp/alice.json set-online false
python -m client --server http://localhost:8000 --store /tmp/alice.json send bob "queued while offline"
python -m client --server http://localhost:8000 --store /tmp/alice.json set-online true
```

## Layout

```
client/__init__.py
client/__main__.py   # arg parsing + one-shot command dispatch
client/protocol.py   # HTTP calls (urllib) + message (de)serialization
client/store.py      # persistent JSON state, atomic writes
client/core.py       # send/flush/poll/reconnect state machine
pyproject.toml
```

## Conformance

From the repo root (needs PyYAML for the harness only):

```bash
python conformance/run.py --client "python -m client" \
    --client-dir clients/python --scenario spec/conformance/scenario_01.yaml
```
