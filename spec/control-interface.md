# Control Interface Specification (generic, language-neutral)

Every client MUST expose this identical command-line control surface. It exists so a
single language-agnostic conformance harness can drive any client and compare
behavior. The *protocol* (`protocol.md`) defines client↔server bytes; this document
defines harness↔client interaction. Nothing language-specific belongs here; how a
language packages its CLI lives in `spec/platform/<language>.md`.

Conformance keywords: **MUST**, **MUST NOT**, **MAY** (RFC 2119).

---

## 1. Execution model

A client is a CLI program invoked **one command per process**. Each invocation:

1. Loads persisted state from `--store`.
2. Performs exactly one command.
3. Persists any state changes.
4. Prints exactly one JSON object as the **final line of stdout**.
5. Exits `0` on success, non-zero on failure.

This one-shot model makes every interaction synchronous and deterministic: the
harness runs a command, reads the final stdout line as JSON, asserts on it, and
moves on. Connectivity is therefore part of persisted state, not an in-memory flag.

## 2. Invocation grammar

```
<launch> --server <url> --store <path> <command> [args...]
```

- `<launch>` is the platform-specific entrypoint (e.g. `python -m client`,
  `node dist/cli.js`). The harness is told this string per language.
- `--server <url>` — server base URL (e.g. `http://localhost:8000`).
- `--store <path>` — path to this client's private local storage (file or dir).
  Each client instance gets its own `--store`, giving full isolation between users.
- `--server`/`--store` MAY also be read from env (`MSG_SERVER`, `MSG_STORE`);
  explicit flags win.

## 3. Output contract

- The final line of stdout MUST be a single JSON object.
- It MUST contain at least `{"ok": <bool>}`.
- On error: `{"ok": false, "error": "<short_code>", "detail": "<text>"}` and a
  non-zero exit code.
- Any other stdout (logs, etc.) MUST precede that final line. stderr is unconstrained.

## 4. Commands

**Identity precondition:** every command except `login` requires an established
identity. If `send`, `flush`, `poll`, or `set-online` is run before `login`, the
client MUST fail cleanly: output `{"ok": false, "error": "no_identity", "detail":
"..."}` and exit non-zero. It MUST NOT invent an identity or crash.

### 4.1 `login <name>`
Set `identity`. If ONLINE, `POST /session`.
Output: `{"ok": true, "user": "<name>"}`

### 4.2 `send <to> <body>`
Compose + enqueue (behavior §3.1); if ONLINE, flush.
Output: `{"ok": true, "id": "<uuid>", "sent": <bool>, "queued_remaining": <int>}`
- `sent` = true if this message reached the server in this call.
- `queued_remaining` = outbox size after the call.

### 4.3 `flush`
Drain the outbox (behavior §3.2).
Output: `{"ok": true, "flushed": <int>, "remaining": <int>}`

### 4.4 `poll`
Fetch and display new messages (behavior §3.3).
Output:
`{"ok": true, "received": [ {"id","from","body","delivery_seq"}, ... ], "cursor": <int>}`
- `received` lists only messages newly displayed in this call, in `delivery_seq` order.

### 4.5 `set-online <true|false>`
Persist the connectivity flag. On a transition **to** `true`, perform the reconnect
sequence (flush, then poll — behavior §3.4) and report its results.
Output:
`{"ok": true, "online": <bool>, "flushed": <int>, "received": [ ... ]}`
- When set to `false`, `flushed`=0 and `received`=[].
- Idempotent: `set-online true` while already ONLINE (and `set-online false` while
  already OFFLINE) is a no-op — it does NOT flush or poll, and reports
  `flushed: 0, received: []`. The reconnect sequence runs only on an actual
  OFFLINE→ONLINE transition.

### 4.6 `dump-state`
Read-only snapshot for assertions.
Output:
```
{"ok": true,
 "identity": "<name|null>",
 "online": <bool>,
 "outbox": [ {"id","to","body"}, ... ],
 "cursor": <int>,
 "displayed_ids": [ "<id>", ... ]}
```

## 5. Determinism requirements

- Commands MUST complete all network and storage I/O before printing and exiting.
- Two clients given different `--store` paths MUST share no state.
- Re-running the same command MUST be safe (idempotent) per the protocol and
  behavior specs.