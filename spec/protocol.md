# Protocol Specification (generic, language-neutral)

This document is the **source of truth** for the wire protocol. Both clients and
the server MUST conform to it exactly. Nothing language-specific belongs here;
implementation choices (HTTP library, storage engine, concurrency model) live in
`spec/platform/<language>.md`.

Conformance keyword convention: **MUST**, **MUST NOT**, **MAY** as in RFC 2119.

---

## 1. Transport

- HTTP/1.1 over `localhost` (no TLS, no auth).
- All request and response bodies are JSON, UTF-8 encoded.
- All requests and responses use `Content-Type: application/json`.
- The server base URL is supplied to clients at startup (e.g. `http://localhost:8000`).
- Clients MUST send the header `X-Protocol-Version: 1` on every request.

## 2. Identity

- A user is identified by a `name`: a non-empty UTF-8 string with no leading or
  trailing whitespace. Names are case-sensitive.
- There is no password or token. A name *is* the identity.
- Re-using an existing name refers to the same user (login is idempotent).

## 3. Message object (the wire schema)

A message is a JSON object with these fields:

| Field          | Type    | Set by | Required on send | Notes |
|----------------|---------|--------|------------------|-------|
| `id`           | string  | client | yes              | UUIDv4, globally unique. Basis for end-to-end dedup. |
| `from`         | string  | client | yes              | Sender name. |
| `to`           | string  | client | yes              | Recipient name. |
| `body`         | string  | client | yes              | Non-empty UTF-8 text, max 4096 bytes. |
| `sent_at`      | string  | client | yes              | RFC 3339 / ISO 8601 UTC timestamp at compose time. Informational only; NOT used for ordering. |
| `delivery_seq` | integer | server | no (server-set)  | Authoritative total order. Absent on send, present on fetch. |

**Extensibility rule:** receivers MUST ignore unknown fields. New features add
*optional* fields; they MUST NOT change the meaning of existing fields. This keeps
old clients working against an evolved spec.

## 4. Endpoints

### 4.1 `POST /session` — log in by name

- Request: `{"name": "<name>"}`
- Success `200`: `{"user": "<name>"}`
- Idempotent: logging in with an existing name returns the same user and is not an error.
- Error `400`: name missing, empty, or whitespace-only.

### 4.2 `POST /messages` — send a message

- Request body: a Message object (without `delivery_seq`).
- The recipient need not have logged in yet; the server holds the message regardless.
- Behaviour:
  - If `id` has not been seen: enqueue into the recipient's inbox, assign the next
    `delivery_seq`, and respond `202`:
    `{"status": "accepted", "id": "<id>", "delivery_seq": <int>}`
  - If `id` has already been seen: do **not** re-enqueue, respond `200`:
    `{"status": "duplicate", "id": "<id>", "delivery_seq": <existing int>}`
- This idempotency on `id` is what makes client retries safe.
- Error `400`: missing/invalid required field.

### 4.3 `GET /messages?user=<name>&after=<delivery_seq>` — poll for messages

- Returns messages addressed **to** `user` whose `delivery_seq` is strictly greater
  than `after`, in ascending `delivery_seq` order.
- `after` defaults to `0` when omitted (i.e. "give me everything").
- Reads are **non-destructive**: the server never deletes on read. Clients advance
  their own cursor. Re-polling with the same `after` MUST return the same messages.
- Success `200`:
  `{"messages": [ <Message with delivery_seq>, ... ], "cursor": <int>}`
  where `cursor` is the largest `delivery_seq` returned, or the supplied `after`
  if no messages matched.

## 5. Ordering and delivery guarantees

- **Total order:** `delivery_seq` is a single server-wide monotonically increasing
  integer assigned at enqueue time. A given recipient sees only a subset of these
  values; gaps are normal and expected.
- **Per-sender order:** messages are enqueued in the order the server receives
  them. Because a client flushes its offline queue in FIFO (compose) order
  (see `behavior.md`), compose order == enqueue order == delivery order for any
  one sender.
- **At-least-once on the wire:** a client MAY retry `POST /messages` and MAY
  re-poll `GET /messages`.
- **Exactly-once on display:** clients MUST dedup by `id` so a message is shown to
  the user at most once, even across retries and reconnects.

## 6. Error envelope

All non-2xx responses use:
`{"error": "<short_code>", "detail": "<human-readable explanation>"}`

## 7. Protocol version

Current version: `1`. The server MAY reject requests whose
`X-Protocol-Version` it does not support with `400`. Additive, backward-compatible
changes keep version `1`; breaking changes increment it.