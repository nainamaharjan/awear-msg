# FUTURE.md

What I'd do next, roughly in priority order. This was a time-boxed exercise; the
items below are deliberately out of the current scope.

## Testing

- **`scenario_02.yaml` for the identity precondition.** The current scenario never
  runs `flush`/`set-online` before `login`, so a divergence there can slip past.
  A small scenario that exercises pre-login commands would lock it down.
- **Automate cross-language interop.** Extend `run.py` to accept a per-actor client
  mapping (Alice = Python, Bob = TypeScript) so the interop demo becomes part of the
  automated suite rather than a manual walk-through.
- **Property/fuzz testing.** Randomized sequences of online/offline/send/poll across
  multiple users, asserting the invariants (no loss, exactly-once, per-sender order)
  hold for any ordering.

## Protocol evolution (the extensibility claim, exercised)

The spec's "ignore unknown fields; new features are optional fields" rule is meant to
make these additive. Each would be: extend the spec, add a scenario, regenerate both
clients with no harness change.

- **Attachments** — an optional `attachment` field (id + content-type + base64 or a
  blob endpoint); offline queueing applies unchanged.
- **Reactions / read receipts** — new message types or optional fields; same delivery
  and dedup machinery.
- **Group conversations** — a `conversation_id` and a fan-out rule in the server;
  the client outbox/cursor model generalizes.

## Transport

- **WebSocket push** as an alternative to polling, behind the same behavior spec, so
  reconnect/flush semantics are unchanged but delivery is real-time.

## More clients

- **A third language** (Swift, Go, or Rust) by adding a single `platform/<lang>.md`
  and running `generate.sh <lang>` — the test of whether the harness is truly
  generic rather than tuned to two similar languages.

## Server hardening (intentionally minimal now)

The assignment says not to over-invest here. Production would add: on-disk
persistence, authentication, rate limiting, and graceful handling of large inboxes.

## Client robustness

- **Real connectivity detection** (timeouts, retry with backoff) rather than only the
  forced-offline test flag.
- **A long-running daemon mode** with periodic polling, in addition to the one-shot
  control commands used for deterministic testing.

## Harness

- **A Codex backend** alongside Claude Code (swap `run_agent` in `generate.sh`).
- **A regeneration gate in CI** that deletes `clients/`, regenerates, and fails the
  build unless conformance passes — making "regeneration works" a continuous check.