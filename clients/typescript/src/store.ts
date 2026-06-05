/**
 * Persistent client state (behavior.md §1).
 *
 * The `--store` path is a single JSON file holding the four pieces of state that
 * MUST survive process restart, plus the persisted connectivity flag (the
 * one-shot execution model means connectivity is state, not an in-memory flag —
 * control-interface.md §1):
 *
 *   identity      : string | null      logged-in user name
 *   online        : boolean            persisted connectivity flag
 *   outbox        : OutgoingMessage[]  composed-but-unacknowledged, FIFO oldest-first
 *   cursor        : number             highest delivery_seq fetched/displayed
 *   displayed_ids : string[]           ids already shown (display-dedup safety net)
 *
 * Saves are atomic (write a temp file in the same dir, then `rename`) so a crash
 * mid-write cannot corrupt the store (spec/platform/typescript.md).
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { OutgoingMessage } from "./protocol";

export class Store {
  readonly path: string;
  identity: string | null = null;
  // Default connectivity is ONLINE: a fresh client assumes the server is
  // reachable and discovers OFFLINE on the first network error (behavior.md §2).
  // The scenario's first commands run online without an explicit set-online true.
  online = true;
  outbox: OutgoingMessage[] = [];
  cursor = 0;
  displayed_ids: string[] = [];

  private constructor(storePath: string) {
    this.path = storePath;
  }

  /** Load persisted state from `storePath`, or start fresh if it is absent. */
  static async load(storePath: string): Promise<Store> {
    const store = new Store(storePath);
    let raw: string;
    try {
      raw = await fs.readFile(storePath, "utf-8");
    } catch {
      // A missing store is a fresh client.
      return store;
    }
    try {
      const data = JSON.parse(raw);
      store.identity =
        typeof data.identity === "string" ? data.identity : null;
      store.online = data.online === undefined ? true : Boolean(data.online);
      store.outbox = Array.isArray(data.outbox) ? data.outbox : [];
      store.cursor = Number.isFinite(data.cursor) ? Number(data.cursor) : 0;
      store.displayed_ids = Array.isArray(data.displayed_ids)
        ? data.displayed_ids
        : [];
    } catch {
      // A corrupt store is treated as empty/fresh rather than crashing the
      // command; the atomic writes below make corruption unlikely anyway.
    }
    return store;
  }

  /** Atomically persist the current state to `this.path`. */
  async save(): Promise<void> {
    const data = {
      identity: this.identity,
      online: this.online,
      outbox: this.outbox,
      cursor: this.cursor,
      displayed_ids: this.displayed_ids,
    };
    const dir = path.dirname(path.resolve(this.path));
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.store-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmp, this.path);
    } catch (err) {
      // Best-effort cleanup of the temp file on any failure.
      try {
        await fs.unlink(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}
