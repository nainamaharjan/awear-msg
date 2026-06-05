/**
 * Persistent client state (behavior.md §1).
 *
 * The `--store` path is a single JSON file holding the entire client state. It
 * MUST survive process restart (this is the whole point of the offline outbox),
 * so writes are atomic: serialize to a temp file in the same directory, then
 * `rename` it over the target (spec/platform/typescript.md). `rename` is atomic
 * on POSIX and Windows, so a crash mid-write leaves the previous good file
 * intact.
 *
 * State shape:
 *   identity      : string | null  -- logged-in user name
 *   online        : boolean        -- persisted connectivity flag (control-interface)
 *   outbox        : Message[]       -- composed-but-unacked messages, FIFO oldest-first
 *   cursor        : number          -- highest delivery_seq fetched + displayed
 *   displayed_ids : string[]        -- ids already shown to the user (display dedup)
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import * as path from "node:path";

export interface Message {
  id: string;
  from: string;
  to: string;
  body: string;
  sent_at: string;
  // delivery_seq is server-set and never present on an outbox message.
}

export interface State {
  identity: string | null;
  online: boolean;
  outbox: Message[];
  cursor: number;
  displayed_ids: string[];
}

export function defaultState(): State {
  return {
    identity: null,
    online: true, // a fresh client is ONLINE until told otherwise
    outbox: [],
    cursor: 0,
    displayed_ids: [],
  };
}

/** Load state from `path`, returning defaults if it does not exist yet. */
export async function load(storePath: string): Promise<State> {
  const state = defaultState();
  if (!storePath) {
    return state;
  }
  let raw: string;
  try {
    raw = await readFile(storePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return state; // no store yet -> defaults
    }
    throw err;
  }
  const data = JSON.parse(raw);
  // Merge over defaults so a partial/older file still yields every key.
  if (data && typeof data === "object") {
    const mutable = state as unknown as Record<string, unknown>;
    for (const key of Object.keys(state)) {
      if (key in data) {
        mutable[key] = data[key];
      }
    }
  }
  return state;
}

/** Atomically persist `state` to `path`. */
export async function save(storePath: string, state: State): Promise<void> {
  const target = path.resolve(storePath);
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const tmp = path.join(
    directory,
    `.store-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(tmp, JSON.stringify(state), "utf-8");
    await rename(tmp, target);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
