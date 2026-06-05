"""Persistent client state (behavior.md §1).

The `--store` path is a single JSON file holding the entire client state. It MUST
survive process restart (this is the whole point of the offline outbox), so writes
are atomic: serialize to a temp file in the same directory, then `os.replace` it
over the target. `os.replace` is atomic on POSIX and Windows, so a crash mid-write
leaves the previous good file intact.

State shape:
    identity      : str | None  -- logged-in user name
    online        : bool        -- persisted connectivity flag (control-interface)
    outbox        : list[dict]   -- composed-but-unacked messages, FIFO oldest-first
    cursor        : int         -- highest delivery_seq fetched + displayed
    displayed_ids : list[str]    -- ids already shown to the user (display dedup)
"""

import json
import os
import tempfile


def default_state():
    return {
        "identity": None,
        "online": True,  # a fresh client is ONLINE until told otherwise
        "outbox": [],
        "cursor": 0,
        "displayed_ids": [],
    }


def load(path):
    """Load state from `path`, returning defaults if it does not exist yet."""
    state = default_state()
    if not path or not os.path.exists(path):
        return state
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    # Merge over defaults so a partial/older file still yields every key.
    if isinstance(data, dict):
        for key in state:
            if key in data:
                state[key] = data[key]
    return state


def save(path, state):
    """Atomically persist `state` to `path`."""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".store-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
