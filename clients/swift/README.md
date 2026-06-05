# Swift messaging client

A headless command-line client for the local messaging app, implemented as a
zero-dependency Swift Package Manager executable. It speaks the wire protocol in
`spec/protocol.md`, implements the offline state machine in `spec/behavior.md`,
and exposes the control interface in `spec/control-interface.md`.

## Requirements

- **Swift 5.9+** toolchain. Developed and verified with Apple Swift 6.2
  (the package pins the Swift 5.9 *tools version* / language mode, so it builds on
  any 5.9+ or 6.x toolchain). On Linux, install from [swift.org]; `URLSession`
  comes from `FoundationNetworking`, which the code imports conditionally.
- No third-party packages — only the standard library and `Foundation`.

[swift.org]: https://www.swift.org/install/

## Build

```sh
swift build -c release
```

This produces the binary at `.build/release/messaging-client` (the launch string
the conformance harness uses).

## Run

```
.build/release/messaging-client --server <url> --store <path> <command> [args...]
```

- `--server <url>` — server base URL, e.g. `http://localhost:8000`
  (optional only for `dump-state`).
- `--store <path>` — JSON file holding this client's persistent state. Each
  client instance gets its own store, giving full isolation between users.
- Both may instead come from `MSG_SERVER` / `MSG_STORE`; explicit flags win.

Each invocation runs exactly one command and prints exactly one JSON object as
the final line of stdout. Exit code is `0` on success, non-zero on failure.

### Commands

| Command | Output (final stdout line) |
|---|---|
| `login <name>` | `{"ok":true,"user":"<name>"}` |
| `send <to> <body>` | `{"ok":true,"id":"<uuid>","sent":<bool>,"queued_remaining":<int>}` |
| `flush` | `{"ok":true,"flushed":<int>,"remaining":<int>}` |
| `poll` | `{"ok":true,"received":[{"id","from","body","delivery_seq"},...],"cursor":<int>}` |
| `set-online <true\|false>` | `{"ok":true,"online":<bool>,"flushed":<int>,"received":[...]}` |
| `dump-state` | `{"ok":true,"identity",...,"outbox":[...],"cursor","displayed_ids":[...]}` |

Every command except `login` requires an established identity; running one before
`login` yields `{"ok":false,"error":"no_identity",...}` and a non-zero exit.

## Example session

```sh
# Boot the server (from the repo root) in another terminal:
python server/app.py --port 8000

BIN=.build/release/messaging-client
S=http://localhost:8000

$BIN --server $S --store /tmp/alice.json login alice
$BIN --server $S --store /tmp/alice.json send bob "hi bob"      # sent online
$BIN --server $S --store /tmp/alice.json set-online false       # go offline
$BIN --server $S --store /tmp/alice.json send bob "queued"      # queues in outbox
$BIN --server $S --store /tmp/alice.json set-online true        # reconnect: flush+poll
$BIN --server $S --store /tmp/bob.json   login bob
$BIN --server $S --store /tmp/bob.json   poll                   # receives both
```

## Layout

```
clients/swift/
  Package.swift
  Sources/messaging-client/
    main.swift       # arg parsing + one-shot command dispatch + final JSON line
    Protocol.swift   # URLSession HTTP calls; Codable wire models
    Store.swift      # load/save persistent state (atomic JSON file)
    Core.swift       # offline state machine (send/flush/poll/reconnect)
  README.md
```

## Conformance

Verified against the language-agnostic harness (PyYAML required for the harness
only):

```sh
python conformance/run.py \
  --client ".build/release/messaging-client" \
  --client-dir clients/swift \
  --scenario spec/conformance/scenario_01.yaml
```

→ `15/15 steps passed`.
