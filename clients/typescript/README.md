# TypeScript messaging client

A spec-driven client for the local messaging app, generated from `spec/`. It
implements the wire protocol (`spec/protocol.md`), the offline state machine
(`spec/behavior.md`), and the control interface (`spec/control-interface.md`),
following `spec/platform/typescript.md`.

Zero third-party runtime dependencies: it uses only Node built-ins (global
`fetch`, `node:crypto`, `node:fs/promises`, `node:util`). The only dev
dependencies are `typescript` and the type-only `@types/node`.

## Requirements

- Node.js 20+ (for built-in `fetch`)
- npm

## Build

```sh
cd clients/typescript
npm install
npm run build      # runs tsc, emitting dist/
```

## Run

Launch string (control-interface.md §2): `node dist/cli.js`.

```sh
node dist/cli.js --server <url> --store <path> <command> [args...]
```

`--server` / `--store` may also come from the `MSG_SERVER` / `MSG_STORE`
environment variables; explicit flags win. `--server` is required for every
command except `dump-state` (which is purely local).

### Commands

| Command                    | Output (final stdout line, JSON)                                         |
|----------------------------|--------------------------------------------------------------------------|
| `login <name>`             | `{"ok":true,"user":"<name>"}`                                            |
| `send <to> <body>`         | `{"ok":true,"id":"<uuid>","sent":<bool>,"queued_remaining":<int>}`      |
| `flush`                    | `{"ok":true,"flushed":<int>,"remaining":<int>}`                         |
| `poll`                     | `{"ok":true,"received":[{id,from,body,delivery_seq}...],"cursor":<int>}` |
| `set-online <true\|false>` | `{"ok":true,"online":<bool>,"flushed":<int>,"received":[...]}`          |
| `dump-state`               | `{"ok":true,"identity",...,"outbox","cursor","displayed_ids"}`          |

Each invocation runs exactly one command, persists state to `--store` (an atomic
JSON file), prints exactly one JSON object as the final stdout line, and exits
`0` on success or non-zero on failure.

### Example session

```sh
# Terminal 1: start the server
python server/app.py --port 8000

# Terminal 2: drive the client
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json login alice
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json send bob "hello"
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json set-online false
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json send bob "queued while offline"
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json set-online true   # flush, then poll
node dist/cli.js --server http://localhost:8000 --store /tmp/alice.json dump-state
```

## Conformance

```sh
pip install pyyaml
python conformance/run.py \
  --client "node dist/cli.js" --client-dir clients/typescript \
  --scenario spec/conformance/scenario_01.yaml
```
