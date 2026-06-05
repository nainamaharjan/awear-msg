# Platform Mapping: TypeScript

How the TypeScript client realizes the generic specs (`protocol.md`, `behavior.md`,
`control-interface.md`). The agent generating `clients/typescript/` MUST follow
this. Generic behavior is fixed by those specs; this file only fixes *how
TypeScript/Node does it*.

## Runtime & dependencies
- Node.js 20+, TypeScript 5+.
- **No third-party runtime dependencies.** Use built-in `fetch`, `node:crypto`,
  `node:fs/promises`, `node:util`. Dev dependencies are `typescript` and
  `@types/node` (the latter is type-only — it ships no runtime code, so the
  no-runtime-dependency rule still holds).

## Project layout & entrypoint
- A package under `clients/typescript/` compiled from `src/` to `dist/`.
- Control-interface launch string (control-interface.md §2): `node dist/cli.js`
  (after building).
- Suggested layout:
  ```
  clients/typescript/
    src/cli.ts         # arg parsing + command dispatch (async main)
    src/protocol.ts    # fetch calls, message (de)serialization
    src/store.ts       # persistent state load/save
    src/core.ts        # send/flush/poll/reconnect logic
    package.json       # build script; no runtime deps
    tsconfig.json
    README.md          # how to build & run
  ```

## Concrete choices
- **HTTP:** the global `fetch` (built into Node 20+). All logic is `async/await`
  inside a single `async main()`; the process exits when it resolves.
- **JSON:** native `JSON.parse` / `JSON.stringify`.
- **Storage:** the `--store` path is a JSON file. Read/write via
  `node:fs/promises`. Use an **atomic write** (write a temp file, then `rename`)
  to avoid corruption. Holds `identity`, `online`, `outbox`, `cursor`,
  `displayed_ids`.
- **UUID:** `crypto.randomUUID()` for message `id`.
- **Timestamps:** `new Date().toISOString()` for `sent_at`.
- **CLI parsing:** `node:util`'s `parseArgs` for `--server` / `--store`, plus the
  positional command and args. Fall back to env `MSG_SERVER` / `MSG_STORE`.
- **Output:** print exactly one JSON object as the final stdout line
  (control-interface.md §3). Exit `0` on success, non-zero on error.

## Run / build
- Build step (the main divergence from Python): `npm install && npm run build`
  (runs `tsc`, emitting `dist/`).
- Run: `node dist/cli.js --server <url> --store <path> <cmd> [args]`