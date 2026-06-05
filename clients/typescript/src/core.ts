/**
 * Client core: the offline state machine (behavior.md §3).
 *
 * Wires together persistence (`Store`) and the wire protocol (`Server`) to
 * implement send / flush / poll / reconnect with the guarantees from
 * behavior.md §4: no loss, per-sender FIFO, exactly-once display, at-least-once
 * on the wire.
 *
 * Each method returns plain data; turning that into the control-interface JSON
 * is the job of `cli.ts`.
 */

import { randomUUID } from "node:crypto";

import {
  IncomingMessage,
  NetworkError,
  OutgoingMessage,
  ProtocolError,
  Server,
  nowIso,
} from "./protocol";
import { Store } from "./store";

/** A command requiring identity was run before `login` (control-interface §4). */
export class NoIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoIdentityError";
  }
}

export class Client {
  constructor(
    private readonly store: Store,
    private readonly server: Server | null,
  ) {}

  // --- helpers ------------------------------------------------------------
  private requireIdentity(): string {
    if (!this.store.identity) {
      throw new NoIdentityError("no identity established; run `login` first");
    }
    return this.store.identity;
  }

  private requireServer(): Server {
    if (!this.server) {
      // Guarded by cli.ts (every command except dump-state requires --server).
      throw new Error("server URL is required for this command");
    }
    return this.server;
  }

  // --- commands -----------------------------------------------------------

  /**
   * Set identity; if ONLINE, register with the server (control-interface §4.1).
   *
   * Login is idempotent server-side (protocol.md §4.1). A network failure here
   * is not fatal: identity is local first, so we still persist it and fall to
   * OFFLINE, matching the "never block on connectivity" spirit of behavior.md.
   */
  async login(name: string): Promise<string> {
    this.store.identity = name;
    if (this.store.online) {
      try {
        await this.requireServer().login(name);
      } catch (err) {
        if (err instanceof NetworkError) {
          this.store.online = false;
        } else {
          // A ProtocolError on login (e.g. bad name) propagates: the server is
          // reachable and actively rejecting, which the caller should surface.
          throw err;
        }
      }
    }
    await this.store.save();
    return name;
  }

  /**
   * Compose + enqueue, flushing if ONLINE (behavior.md §3.1).
   *
   * Returns `[id, sent, queuedRemaining]`. `send` never blocks on or fails due
   * to connectivity: the message is persisted to the outbox first, so it is
   * never lost.
   */
  async send(to: string, body: string): Promise<[string, boolean, number]> {
    const identity = this.requireIdentity();
    const message: OutgoingMessage = {
      id: randomUUID(),
      from: identity,
      to,
      body,
      sent_at: nowIso(),
    };
    // Persist to the outbox BEFORE any network I/O (behavior.md §3.1 step 2).
    this.store.outbox.push(message);
    await this.store.save();

    let sent = false;
    if (this.store.online) {
      await this.flush();
      // `sent` is true iff this id is no longer queued, i.e. it reached the
      // server in this call.
      sent = !this.store.outbox.some((m) => m.id === message.id);
    }

    return [message.id, sent, this.store.outbox.length];
  }

  /**
   * Drain the outbox oldest-first (behavior.md §3.2). Returns count flushed.
   *
   * Stops at the first network error (transition to OFFLINE) or protocol error
   * (server reachable but rejecting). Resumable: later calls continue from the
   * oldest remaining message.
   */
  async flush(): Promise<number> {
    this.requireIdentity();
    const server = this.requireServer();
    let flushed = 0;
    while (this.store.outbox.length > 0) {
      const message = this.store.outbox[0];
      try {
        await server.send(message);
      } catch (err) {
        if (err instanceof NetworkError) {
          // Unreachable: stop, leave this and all later messages in order.
          this.store.online = false;
          await this.store.save();
          return flushed;
        }
        if (err instanceof ProtocolError) {
          // Reachable but rejected: do NOT drop the message, do NOT go offline.
          // Surface by stopping the flush (behavior.md §3.2 step 4).
          await this.store.save();
          throw err;
        }
        throw err;
      }
      // 202 accepted or 200 duplicate: drop from outbox and persist, then
      // continue to the next message.
      this.store.online = true;
      this.store.outbox.shift();
      await this.store.save();
      flushed += 1;
    }
    return flushed;
  }

  /**
   * Fetch and display new messages (behavior.md §3.3).
   *
   * Returns the list of newly displayed messages in `delivery_seq` order. Only
   * runs while ONLINE; a network error transitions to OFFLINE.
   */
  async poll(): Promise<IncomingMessage[]> {
    const identity = this.requireIdentity();
    if (!this.store.online) {
      return [];
    }
    const server = this.requireServer();

    let messages: IncomingMessage[];
    let cursor: number;
    try {
      [messages, cursor] = await server.fetchMessages(
        identity,
        this.store.cursor,
      );
    } catch (err) {
      if (err instanceof NetworkError) {
        this.store.online = false;
        await this.store.save();
        return [];
      }
      throw err;
    }

    this.store.online = true;
    const displayed = new Set(this.store.displayed_ids);
    const newly: IncomingMessage[] = [];
    const ordered = [...messages].sort(
      (a, b) => a.delivery_seq - b.delivery_seq,
    );
    for (const msg of ordered) {
      if (!displayed.has(msg.id)) {
        displayed.add(msg.id);
        this.store.displayed_ids.push(msg.id);
        newly.push(msg);
      }
    }
    // Advance the cursor and persist cursor + displayed_ids together.
    this.store.cursor = cursor;
    await this.store.save();
    return newly;
  }

  /**
   * Persist connectivity; on an OFFLINE->ONLINE transition, reconnect.
   *
   * Reconnect is flush-then-poll (behavior.md §3.4). Idempotent: setting to a
   * value already held is a no-op and runs neither flush nor poll
   * (control-interface.md §4.5). Returns `[flushed, received]`.
   */
  async setOnline(online: boolean): Promise<[number, IncomingMessage[]]> {
    this.requireIdentity();
    const wasOnline = this.store.online;

    if (online && !wasOnline) {
      // Actual OFFLINE -> ONLINE transition: reconnect.
      this.store.online = true;
      await this.store.save();
      const flushed = await this.flush();
      const received = await this.poll();
      return [flushed, received];
    }

    // No transition (or going offline): just persist the flag.
    this.store.online = online;
    await this.store.save();
    return [0, []];
  }
}
