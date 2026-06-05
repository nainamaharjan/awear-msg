# Behavior Specification (generic, language-neutral)

This document defines client-side behavior: local state, connectivity, the offline
send queue, receiving, and the guarantees that follow. It builds directly on
`protocol.md` (message `id`, server `delivery_seq`, idempotent send, cursor-based
non-destructive reads). Nothing language-specific belongs here.

Conformance keywords: **MUST**, **MUST NOT**, **MAY** (RFC 2119).

---

## 1. Persistent client state

Every client maintains the following, and it **MUST survive process restart**
(persisted to local storage; storage mechanism is platform-specific):

| State          | Type            | Meaning |
|----------------|-----------------|---------|
| `identity`     | string          | The logged-in user name. |
| `outbox`       | ordered list    | Composed messages not yet acknowledged by the server, oldest first (FIFO). |
| `cursor`       | integer         | Highest `delivery_seq` already fetched and displayed. Starts at `0`. |
| `displayed_ids`| set of strings  | Message `id`s already shown to the user (display-dedup safety net). |

## 2. Connectivity state

A client is in exactly one of two states:

- **ONLINE** — the server is reachable.
- **OFFLINE** — the server is not reachable, or the client has been told to act offline.

Transitions:
- Any network error on a request transitions the client to **OFFLINE**.
- Any successful request implies the client is **ONLINE**.
- For deterministic testing, the control interface (`set-online <bool>`, see
  `control-interface.md`) forces the state and gates all network I/O.

```
            send() always enqueues (works in both states)
                 ┌───────────────────────────────┐
                 v                                 │
   ┌─────────┐  network error / set-online false  ┌─────────┐
   │ ONLINE  │ ─────────────────────────────────> │ OFFLINE │
   │         │ <───────────────────────────────── │         │
   └─────────┘  success / set-online true          └─────────┘
        │        (on entry: flush, then poll)
        │ periodic poll + flush
```

## 3. Operations

### 3.1 `send(to, body)` — never lost, never blocks

1. Construct a message: `id` = new UUIDv4, `from` = `identity`, `to`, `body`,
   `sent_at` = current UTC time.
2. Append it to the `outbox` and **persist** before doing anything else.
3. If ONLINE, trigger `flush()`. If OFFLINE, stop — the message waits in the outbox.

`send` MUST NOT block on or fail due to connectivity. Enqueuing first is what
guarantees no message is lost when offline.

### 3.2 `flush()` — drain the outbox in order

Process `outbox` oldest-first:

1. For the oldest message, `POST /messages`.
2. On `202 accepted` **or** `200 duplicate`: remove it from the outbox and persist,
   then continue to the next message. (A `duplicate` means a previous attempt already
   succeeded; dropping it is correct.)
3. On network error: transition to OFFLINE and **stop**. This message and all later
   ones remain in the outbox in their original order.

`flush()` is idempotent and resumable — calling it repeatedly is safe and simply
continues from the oldest remaining message.

### 3.3 `poll()` — receive and display

Only runs while ONLINE.

1. `GET /messages?user=<identity>&after=<cursor>`.
2. On success, for each returned message in ascending `delivery_seq` order:
   - If its `id` is not in `displayed_ids`: display it, add the `id` to `displayed_ids`.
3. Set `cursor` to the response's `cursor` and **persist** (`cursor` and
   `displayed_ids` together).
4. On network error: transition to OFFLINE.

Re-polling with the same `cursor` is harmless: the server returns the same messages
(non-destructive reads) and `displayed_ids` prevents any double display.

### 3.4 Reconnect: OFFLINE → ONLINE

On regaining connectivity the client **MUST**, in this order:

1. `flush()` the outbox, then
2. `poll()`.

The two directions are logically independent, but mandating **flush-before-poll**
makes both client implementations deterministic and the scenarios reproducible.

### 3.5 Startup / restart

1. Load persisted `identity`, `outbox`, `cursor`, `displayed_ids`.
2. If `identity` is set and the client is ONLINE, run the reconnect sequence
   (flush, then poll).

### 3.6 Periodic operation while ONLINE

While ONLINE the client `flush()`es and `poll()`s on a periodic interval (default
~1s; configurable per platform). The control interface also exposes an explicit
`poll` command so tests can drive the client deterministically instead of waiting
for the timer. Behavior MUST be identical whether triggered by timer or command.

## 4. Guarantees (and where they come from)

- **No loss:** a composed message stays in the outbox until the server returns
  `accepted` or `duplicate` (§3.1–3.2).
- **Per-sender FIFO:** the outbox flushes oldest-first, so a single sender's
  messages reach the server — and thus the recipient — in compose order (§3.2 +
  protocol §5).
- **Exactly-once display:** monotonic `cursor` plus `displayed_ids` dedup (§3.3).
- **At-least-once on the wire:** retries are safe because `POST /messages` is
  idempotent on `id` (protocol §4.2).

## 5. Edge cases (both clients MUST handle identically)

- **Partial flush:** if the 2nd of 3 queued messages fails, #1 is already removed,
  #2 and #3 remain in order; the next flush resumes at #2.
- **Duplicate ack on flush:** a `200 duplicate` is treated as success — remove from
  outbox.
- **Send to a not-yet-logged-in recipient:** accepted and held by the server;
  delivered when that recipient first polls.
- **Offline indefinitely:** queued messages persist in the outbox across restarts
  until a flush succeeds.
- **Re-poll same cursor:** returns the same messages; nothing is displayed twice.