# DESIGN.md

## Thesis

The deliverable is a generator, so the design goal is **reproducibility**: the same
spec, run through the same harness, yields behaviorally identical clients. Four
artifacts divide the labor:

- **Spec** (`spec/`) — the contract. The single source of truth for behavior.
- **Harness** (`harness/`, `CLAUDE.md`) — the compiler. Turns spec + target language
  into client code via an agent.
- **Conformance runner** (`conformance/run.py`) — the type-checker. Proves a client
  obeys the contract.
- **Two clients** (`clients/`) — the proof. Two independent implementations in
  languages that can't share source; if both pass the same suite, the contract is
  unambiguous.

## Generic vs platform-specific

The spec is split deliberately:

- **Generic** (`protocol.md`, `behavior.md`, `control-interface.md`) — language
  neutral: the wire protocol, the offline state machine, the CLI surface.
- **Platform** (`platform/python.md`, `platform/typescript.md`) — how each language
  realizes the generic spec: HTTP client, JSON, storage, concurrency, build step.

Python and TypeScript are similar, so the honest divergences are narrow: runtime,
transport (`urllib` vs `fetch`), concurrency (sync vs `async/await`), and TS's `tsc`
build phase. Storage *converged* on an atomically-written JSON file for both —
documenting where two platforms genuinely differ (and where they don't) is part of
the exercise.

## Protocol decisions

- **HTTP with cursor-based polling**, not WebSocket. Offline/reconnect semantics are
  easier to specify precisely against request/response than against a stream.
- **Client-generated message `id` + idempotent `POST`.** This is the linchpin of the
  offline story: a client can safely retry a queued send after reconnecting, and the
  server returns `duplicate` instead of enqueuing twice.
- **Non-destructive, cursor-based reads.** The server never deletes on poll; clients
  track their own cursor. A client can crash or re-poll with no loss and no dupes.
- **A single server-wide `delivery_seq`** gives one total order, so "did both clients
  see the same order?" is a trivial assertion.

## Offline state machine

- **Send always enqueues first, then attempts delivery.** Enqueuing before consulting
  connectivity is what guarantees no message is lost when offline.
- **Flush-before-poll on reconnect.** The two directions are independent, so a fixed
  order isn't required for correctness — but mandating it makes both implementations
  deterministic and the scenarios reproducible.
- **Exactly-once display** via a monotonic cursor plus an `id` dedup set; **at-least-
  once on the wire** via idempotent send.

## The control interface

Every client exposes the *same* one-shot CLI: load state, do one command, print a
single JSON object as the final stdout line, exit. This is what lets one language-
agnostic conformance runner drive any client — it only parses that final JSON line.
Connectivity is persisted state (a flag in the store), not an in-memory daemon,
which keeps every interaction synchronous and deterministic.

## The harness

`CLAUDE.md` turns a fresh agent into a disciplined generator. The decisions that
matter:

- **Hard boundaries** — the agent writes only inside the target `clients/<lang>`,
  never the spec, server, or the other client. This is what makes "delete and
  regenerate" safe.
- **Ambiguity protocol** — if the spec is silent, the agent makes a minimal choice
  and *reports* it instead of editing the spec or guessing silently. This drove the
  iteration loop: surfaced gaps → tightened spec → regenerated.
- **Self-verification** — the agent builds, boots the server, exercises the full
  online/offline/reconnect cycle, and runs conformance before declaring done.
- **Swappable tool** — `generate.sh` invokes the agent in one function (`run_agent`);
  switching Claude Code → Codex touches nothing else.
- **Parametric over language** — the prompt is a template filled per target, so
  adding a language is adding a `platform/<lang>.md` and running `generate.sh <lang>`.

## Quality strategy

Correctness is checked four ways: the automated conformance runner (15-step
scenario, both clients), the agent's own self-verification during generation, a
manual cross-language interop demo, and the ambiguity-surfacing loop that kept the
two clients converging.

That loop earned its keep: the TypeScript client (generated after the spec was
tightened) caught that the earlier Python client guarded fewer commands against a
missing identity than the spec required. The fix was to tighten the spec and
regenerate — the second, independent implementation exposed an inconsistency the
first couldn't, which is precisely why two clients from one spec is the right test.