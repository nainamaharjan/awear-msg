# TypeScript messaging client

A spec-driven client for the local messaging app. Generated from `spec/`
(`protocol.md`, `behavior.md`, `control-interface.md`, `spec/platform/typescript.md`).

## Requirements

- Node.js 20+ (uses the built-in global `fetch`), TypeScript 5+.
- **No third-party runtime dependencies** — Node standard library only. The only
  dev dependencies are `typescript` and `@types/node` (type-only; ships no runtime
  code).

## Build

From this directory (`clients/typescript/`):

```bash
npm install && npm run build
```

This runs `tsc`, emitting JavaScript to `dist/`.

## Run

The launch string is `node dist/cli.js`, invoked **one command per process**:

```bash
node dist/cli.js --server <url> --store <path> <command> [args...]
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

cd clients/typescript
npm install && npm run build
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json login alice
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json send bob "hi"

# go offline, queue a message, then reconnect (flush + poll):
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json set-online false
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json send bob "queued while offline"
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json set-online true
```

## Layout

```
src/cli.ts        # arg parsing + one-shot command dispatch (async main)
src/protocol.ts   # fetch calls + message (de)serialization
src/store.ts      # persistent JSON state, atomic writes
src/core.ts       # send/flush/poll/reconnect state machine
package.json      # build script; no runtime deps
tsconfig.json
```

## Conformance

From the repo root (the harness needs PyYAML; the client and server stay
dependency-free):

```bash
python conformance/run.py --client "node dist/cli.js" \
    --client-dir clients/typescript --scenario spec/conformance/scenario_01.yaml
```
