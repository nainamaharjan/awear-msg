# Spec-Driven Messaging Client Generator

A **code generator**: a written spec plus an agentic harness produce two working
messaging clients in different languages (Python and TypeScript). The clients are
generated; the spec, harness, server, and tests are hand-written. Delete the
clients, run the generator, and you get them back — behavior unchanged.

> The messaging app is the *example* used to exercise the generator. The generator
> (spec + harness) is the actual deliverable.

## Repository layout

| Path | What it is | Authorship |
|------|------------|------------|
| `spec/` | **Source of truth.** Protocol, behavior, control interface, platform mappings, conformance scenario. | Hand-written |
| `harness/` | **The agentic harness.** `generate.sh`, the prompt template, generation logs. | Hand-written |
| `CLAUDE.md` | Rules the generating agent follows (boundaries, ambiguity protocol, self-verification). | Hand-written |
| `server/` | Trivial in-memory server implementing the protocol. Outside generator discipline. | Hand-written |
| `conformance/` | `run.py`, the language-agnostic judge that replays the scenario against any client. | Hand-written |
| `clients/python/` | The Python client. | **Generated** |
| `clients/typescript/` | The TypeScript client. | **Generated** |

**Regeneration boundary:** everything under `clients/` is generated. Delete it and
run `./harness/generate.sh all` to rebuild it from `spec/`. Everything else is
hand-written.

## Prerequisites

- Python 3.11+
- Node.js 20+ (for the TypeScript client)
- An agentic CLI: Claude Code (`claude`) or Codex (to regenerate clients)
- `pip install pyyaml` (for the conformance runner only)

The generated clients and the server use **no third-party runtime dependencies**
(Python stdlib; Node built-ins). TypeScript's only dev dependencies are `typescript`
and `@types/node` (type-only).

## Quickstart

```bash
# 1. start the server
python server/app.py --port 8000

# 2. (clients are committed; to regenerate them, see below)

# 3. grade each client against the spec's conformance scenario
pip install pyyaml

( cd clients/typescript && npm install && npm run build )

python conformance/run.py --client "python -m client"  --client-dir clients/python \
  --scenario spec/conformance/scenario_01.yaml

python conformance/run.py --client "node dist/cli.js"  --client-dir clients/typescript \
  --scenario spec/conformance/scenario_01.yaml
```

Each prints `15/15 steps passed`.

## Regeneration (primary criterion)

Delete the generated clients and rebuild them purely from the spec:

```bash
rm -rf clients/python clients/typescript

./harness/generate.sh all

( cd clients/typescript && npm install && npm run build )

python conformance/run.py --client "python -m client" --client-dir clients/python \
  --scenario spec/conformance/scenario_01.yaml

python conformance/run.py --client "node dist/cli.js" --client-dir clients/typescript \
  --scenario spec/conformance/scenario_01.yaml
```

Both conformance runs passing confirms the clients were reproduced from the spec.

## Demo: two clients talking to each other

The conformance runner tests each client in isolation. To see the two *different*
clients interoperate through the server (Python Alice ↔ TypeScript Bob):

```bash
python server/app.py --port 8000 &

( cd clients/typescript && npm install && npm run build )

pyalice() { env PYTHONPATH=clients/python python -m client --server http://localhost:8000 --store /tmp/alice.json "$@"; }

tsbob()   { node clients/typescript/dist/cli.js --server http://localhost:8000 --store /tmp/bob.json "$@"; }

rm -f /tmp/alice.json /tmp/bob.json

pyalice login alice
tsbob   login bob
pyalice send bob "Hi Bob, I have something important to tell you"
tsbob   poll                                   # Bob receives Alice's message
tsbob   send alice "What is it?"
pyalice poll                                   # Alice receives Bob's reply
pyalice set-online false
pyalice send bob "I'm getting promoted to lead the lab"   # queued offline
tsbob   set-online false
tsbob   send alice "Tell me the moment you can"           # queued offline
pyalice set-online true                         # Alice's queued msg flushes
pyalice set-online false
tsbob   set-online true                         # Bob flushes his own + receives Alice's
pyalice set-online true                         # Alice receives Bob's queued msg
```

All four messages are delivered exactly once, in order, across the offline gap.

## How it works

The spec is the contract; the harness is the compiler; the conformance runner is
the type-checker; the two clients are the proof the contract is unambiguous. See
[DESIGN.md](DESIGN.md) for the principles and [FUTURE.md](FUTURE.md) for what's next.

## Adding a new language: Swift (tested)

To confirm the harness generalizes beyond two similar languages, I added a third
client in **Swift** — a headless SwiftPM command-line executable, not an iOS app —
and verified it the same way as the others. The generic spec was unchanged; only a
new platform mapping and one line in the harness were needed.

1. Add a platform mapping `spec/platform/swift.md` (how Swift realizes the generic
   spec: URLSession, Codable, atomic file storage, the launch string).

2. Add `swift` to the target allowlist in `harness/generate.sh`:

```bash
case "$1" in
  python|typescript|swift) generate_one "$1" ;;
  all)               generate_one python; generate_one typescript; generate_one swift ;;
  *)                 usage ;;
esac
```

3. Generate, build, and verify:

```bash
./harness/generate.sh swift

( cd clients/swift && swift build -c release )

python conformance/run.py --client ".build/release/messaging-client" --client-dir clients/swift \
  --scenario spec/conformance/scenario_01.yaml
```
To run as a client: 

```bash
swiftcarol() { clients/swift/.build/release/messaging-client --server http://localhost:8000 --store /tmp/carol.json "$@"; }

rm -f /tmp/carol.json
```

The Swift client passes the same `scenario_01.yaml` (15/15) and interoperates with
the Python and TypeScript clients through the server — confirming that the spec, not
the language, defines behavior. Any further language can be added the same way.

## How it works

The spec is the contract; the harness is the compiler; the conformance runner is
the type-checker; the two clients are the proof the contract is unambiguous. See
[DESIGN.md](DESIGN.md) for the principles and [FUTURE.md](FUTURE.md) for what's next.