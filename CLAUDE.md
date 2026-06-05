# CLAUDE.md — Generation Harness Rules

This repository is a **spec-driven code generator**. Hand-written specs in `spec/`
are the source of truth; the per-language clients in `clients/` are *generated*
from them. The core promise: delete `clients/`, run `harness/generate.sh`, and get
back working clients whose behavior matches the spec.

When you are run by `harness/generate.sh`, your job is to generate (or regenerate)
**one** client. The target is provided to you as `TARGET_LANGUAGE` and `OUTPUT_DIR`.
Follow these rules exactly.

## 1. Read the source of truth first

Before writing any code, read, in this order:
1. `spec/protocol.md` — the wire protocol (endpoints, message schema, idempotency, ordering).
2. `spec/behavior.md` — the client offline state machine (outbox, cursor, flush, reconnect).
3. `spec/control-interface.md` — the CLI surface every client MUST expose.
4. `spec/platform/<TARGET_LANGUAGE>.md` — how this language realizes the above.
5. `spec/conformance/scenario_01.yaml` — the behavior your client MUST reproduce.

The generic specs (1–3) define *what*; the platform file (4) defines *how* for your
language. Implement both faithfully.

## 2. Precedence and ambiguity

- The spec is authoritative. If existing code and the spec disagree, the spec wins.
- If the spec is **ambiguous or silent** on something you need, do NOT invent
  behavior and do NOT edit the spec. Make the smallest reasonable choice, and
  clearly report the ambiguity and your choice in your final summary so a human can
  tighten the spec. Surfacing spec gaps is more valuable than hiding them.

## 3. Hard boundaries (do not cross)

- Write **only** inside `OUTPUT_DIR` (`clients/<TARGET_LANGUAGE>/`).
- NEVER modify `spec/`, `server/`, `conformance/`, `harness/`, or the other
  client's directory.
- Treat everything outside `OUTPUT_DIR` as read-only reference.

## 4. What to build

A client implementing:
- The protocol calls from `protocol.md`.
- The full offline state machine from `behavior.md` (no message loss, exactly-once
  display, per-sender ordering, flush-then-poll reconnect).
- The exact CLI control surface from `control-interface.md`: commands `login`,
  `send`, `flush`, `poll`, `set-online`, `dump-state`; global `--server` / `--store`
  flags; the launch string named in the platform file; one JSON object as the final
  stdout line; correct exit codes.
- Persistent state at `--store` that survives process restart, written atomically.

## 5. Constraints

- **No messaging/chat SDKs.** General-purpose libraries (HTTP, JSON, storage) are
  allowed; the platform file states the preferred (zero-dependency) choices.
- **Local only.** No cloud, no third-party services.
- Match the dependency policy in the platform file.

## 6. Verify before you finish

Do not declare done until you have checked your own work:
1. Build if the platform requires it (e.g. TypeScript `npm install && npm run build`).
2. Start the server (`python server/app.py --port 8000`) in the background.
3. Manually exercise the control interface against it: `login`, `send` while online,
   `set-online false` + `send` (should queue), `set-online true` (should flush),
   `poll` (should receive). Confirm the JSON outputs match the specs.
4. If feasible, run `python conformance/run.py` against your client and confirm it
   passes `scenario_01.yaml`.
Report exactly what you ran and its results in your final summary.

## 7. Quality bar

- Small, focused modules as suggested in the platform file's layout.
- Handle network errors as the OFFLINE transition (behavior.md §2), never crash.
- Idiomatic for the target language; clear names; minimal cleverness.
- Include a short `README.md` in `OUTPUT_DIR` with build/run commands.