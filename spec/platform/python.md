# Platform Mapping: Python

How the Python client realizes the generic specs (`protocol.md`, `behavior.md`,
`control-interface.md`). The agent generating `clients/python/` MUST follow this.
Generic behavior is fixed by those specs; this file only fixes *how Python does it*.

## Runtime & dependencies
- CPython 3.11+.
- **No third-party runtime dependencies.** Use only the standard library. (This
  keeps regeneration reproducible with no install step.) `httpx`/`requests` would
  be acceptable general-purpose HTTP libraries, but stdlib is preferred here.

## Project layout & entrypoint
- A package under `clients/python/` runnable as a module.
- Control-interface launch string (control-interface.md §2): `python -m client`
- Suggested layout:
  ```
  clients/python/
    client/__init__.py
    client/__main__.py      # arg parsing + command dispatch
    client/protocol.py      # HTTP calls, message (de)serialization
    client/store.py         # persistent state load/save
    client/core.py          # send/flush/poll/reconnect logic
    pyproject.toml          # metadata; no runtime deps
    README.md               # how to run
  ```

## Concrete choices
- **HTTP:** `urllib.request` + `urllib.error` (synchronous). Each command is a
  one-shot process, so no event loop or async is needed.
- **JSON:** `json` module.
- **Storage:** the `--store` path is a JSON file. Load with `json.load`, save with
  an **atomic write** (write to a temp file in the same dir, then `os.replace`) to
  avoid corruption on crash. The file holds `identity`, `online`, `outbox`,
  `cursor`, `displayed_ids`.
- **UUID:** `uuid.uuid4()` (string form) for message `id`.
- **Timestamps:** `datetime.now(timezone.utc).isoformat()` for `sent_at`.
- **CLI parsing:** `argparse`. Global flags `--server`, `--store`; positional
  `command` plus its args. Fall back to env `MSG_SERVER` / `MSG_STORE`.
- **Output:** print exactly one JSON object as the final stdout line
  (control-interface.md §3). Exit `0` on success, non-zero on error.

## Run / build
- No build step. Run directly: `python -m client --server <url> --store <path> <cmd> [args]`