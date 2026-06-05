# Python messaging client

A dependency-free Python client for the local messaging protocol. Generated from
the specs in `spec/` (protocol, behavior, control interface) per the Python
platform mapping. Standard library only — no install step, no runtime
dependencies.

## Requirements

- CPython 3.11+

## Run

The client is a package runnable as a module. The launch string is `python -m client`.
Run it from this directory (`clients/python/`):

```
python -m client --server <url> --store <path> <command> [args...]
```

- `--server <url>` — server base URL, e.g. `http://localhost:8000`
  (optional only for `dump-state`, which is purely local).
- `--store <path>` — path to this client's private JSON state file. Each user gets
  its own store, giving full isolation.
- Both may also be supplied via the env vars `MSG_SERVER` / `MSG_STORE`; explicit
  flags win.

Every invocation runs exactly one command and prints exactly one JSON object as the
final line of stdout. Exit code is `0` on success, non-zero on failure.

### Commands

| Command                 | Output (final stdout line)                                              |
|-------------------------|------------------------------------------------------------------------|
| `login <name>`          | `{"ok": true, "user": "<name>"}`                                       |
| `send <to> <body>`      | `{"ok": true, "id": "<uuid>", "sent": <bool>, "queued_remaining": <int>}` |
| `flush`                 | `{"ok": true, "flushed": <int>, "remaining": <int>}`                   |
| `poll`                  | `{"ok": true, "received": [...], "cursor": <int>}`                     |
| `set-online <bool>`     | `{"ok": true, "online": <bool>, "flushed": <int>, "received": [...]}`  |
| `dump-state`            | `{"ok": true, "identity", "online", "outbox", "cursor", "displayed_ids"}` |

On error: `{"ok": false, "error": "<code>", "detail": "<text>"}` with a non-zero exit.

## Example session

```bash
# Start the server (from the repo root, in another shell):
python server/app.py --port 8000

# Drive the client:
python -m client --server http://localhost:8000 --store /tmp/alice.json login alice
python -m client --server http://localhost:8000 --store /tmp/alice.json send bob "hi bob"
python -m client --server http://localhost:8000 --store /tmp/alice.json set-online false
python -m client --server http://localhost:8000 --store /tmp/alice.json send bob "queued while offline"
python -m client --server http://localhost:8000 --store /tmp/alice.json set-online true   # flush then poll
python -m client --server http://localhost:8000 --store /tmp/alice.json dump-state
```

## Conformance

From the repo root, with PyYAML installed for the harness (`pip install pyyaml`):

```bash
python conformance/run.py \
  --client "python -m client" --client-dir clients/python \
  --scenario spec/conformance/scenario_01.yaml
```

## Layout

```
client/__init__.py    package marker
client/__main__.py    arg parsing + command dispatch (the CLI surface)
client/protocol.py    HTTP calls + message (de)serialization (urllib, json)
client/store.py       persistent state, atomic writes
client/core.py        send/flush/poll/reconnect state machine
pyproject.toml        metadata; no runtime deps
```
