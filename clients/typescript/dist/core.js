"use strict";
/**
 * Client state machine: send / flush / poll / reconnect (behavior.md §3).
 *
 * `Client` operates on an in-memory copy of the persisted state object. Each
 * control command mutates the state; the caller (`cli.ts`) persists once at the
 * end of the command. Because each invocation runs exactly one command in its
 * own process (control-interface.md §1), a single atomic save at the end
 * preserves the no-loss invariant: either the whole command's effect is durable
 * or none of it is. If the process dies after a successful POST but before the
 * save, the message is still in the outbox and will be re-sent next run; the
 * server dedups on `id` (protocol.md §4.2), so it is neither lost nor displayed
 * twice.
 *
 * Connectivity is a persisted flag that gates all network I/O (behavior.md §2).
 * A network error during any request flips the flag to OFFLINE.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Client = void 0;
const node_crypto_1 = require("node:crypto");
const protocol = __importStar(require("./protocol"));
class Client {
    state;
    server;
    constructor(state, server) {
        this.state = state;
        // protocol.md §1: base URL supplied at startup; tolerate a trailing slash.
        this.server = server ? server.replace(/\/+$/, "") : server;
    }
    // --- connectivity ----------------------------------------------------
    get online() {
        return Boolean(this.state.online);
    }
    goOffline() {
        this.state.online = false;
    }
    // --- login (control-interface.md §4.1) -------------------------------
    async login(name) {
        this.state.identity = name;
        if (this.online) {
            try {
                await protocol.postSession(this.server, name);
                // Any successful request implies ONLINE; nothing else to do.
            }
            catch (err) {
                if (err instanceof protocol.NetworkError) {
                    this.goOffline();
                }
                else {
                    throw err;
                }
            }
        }
        return { ok: true, user: name };
    }
    // --- send (control-interface.md §4.2, behavior.md §3.1) --------------
    async send(to, body) {
        const message = {
            id: (0, node_crypto_1.randomUUID)(),
            from: this.state.identity,
            to,
            body,
            sent_at: new Date().toISOString(),
        };
        // Enqueue first — this is what guarantees no loss when offline.
        this.state.outbox.push(message);
        if (this.online) {
            await this.flush();
        }
        const stillQueued = this.state.outbox.some((m) => m.id === message.id);
        return {
            ok: true,
            id: message.id,
            sent: !stillQueued,
            queued_remaining: this.state.outbox.length,
        };
    }
    // --- flush (control-interface.md §4.3, behavior.md §3.2) -------------
    /** Drain the outbox oldest-first. Returns the count flushed this call. */
    async flush() {
        let flushed = 0;
        if (!this.online) {
            // OFFLINE gates network I/O; nothing leaves the outbox.
            return flushed;
        }
        while (this.state.outbox.length > 0) {
            const message = this.state.outbox[0];
            let result;
            try {
                result = await protocol.postMessage(this.server, message);
            }
            catch (err) {
                if (err instanceof protocol.NetworkError) {
                    // behavior.md §3.2 step 3: go OFFLINE and stop; order preserved.
                    this.goOffline();
                    break;
                }
                throw err;
            }
            const ack = result.payload.status;
            if ((result.status === 202 || result.status === 200) &&
                (ack === "accepted" || ack === "duplicate")) {
                // accepted or duplicate both mean "the server has it" -> drop it.
                this.state.outbox.shift();
                flushed += 1;
            }
            else {
                // behavior.md §3.2 step 4: reachable but rejected. Keep the message,
                // stay ONLINE, stop the flush. (Should not happen for well-formed
                // messages.)
                break;
            }
        }
        return flushed;
    }
    // --- poll (control-interface.md §4.4, behavior.md §3.3) -------------
    /**
     * Fetch new messages, display (dedup), advance cursor.
     * Returns the list of newly displayed messages in delivery_seq order.
     */
    async poll() {
        const received = [];
        if (!this.online) {
            return received; // poll only runs while ONLINE (behavior.md §3.3)
        }
        let result;
        try {
            result = await protocol.getMessages(this.server, this.state.identity, this.state.cursor);
        }
        catch (err) {
            if (err instanceof protocol.NetworkError) {
                this.goOffline();
                return received;
            }
            throw err;
        }
        if (result.status !== 200) {
            // Reachable but errored; leave cursor untouched and surface nothing.
            return received;
        }
        const displayed = new Set(this.state.displayed_ids);
        const messages = (result.payload.messages ?? [])
            .slice()
            .sort((a, b) => (a.delivery_seq ?? 0) - (b.delivery_seq ?? 0));
        for (const m of messages) {
            const mid = m.id;
            if (!displayed.has(mid)) {
                received.push({
                    id: mid,
                    from: m.from,
                    body: m.body,
                    delivery_seq: m.delivery_seq,
                });
                displayed.add(mid);
            }
        }
        this.state.cursor = result.payload.cursor ?? this.state.cursor;
        this.state.displayed_ids = Array.from(displayed);
        return received;
    }
    // --- set-online (control-interface.md §4.5, behavior.md §3.4) -------
    async set_online(value) {
        const wasOnline = this.online;
        this.state.online = value;
        let flushed = 0;
        let received = [];
        if (value && !wasOnline) {
            // Genuine OFFLINE -> ONLINE transition: reconnect = flush then poll.
            flushed = await this.flush();
            received = await this.poll();
        }
        return {
            ok: true,
            // Report the actual flag: flush/poll may have flipped it back to OFFLINE
            // if the server turned out to be unreachable.
            online: this.online,
            flushed,
            received,
        };
    }
    // --- dump-state (control-interface.md §4.6) -------------------------
    dump_state() {
        return {
            ok: true,
            identity: this.state.identity,
            online: this.online,
            outbox: this.state.outbox.map((m) => ({
                id: m.id,
                to: m.to,
                body: m.body,
            })),
            cursor: this.state.cursor,
            displayed_ids: Array.from(this.state.displayed_ids),
        };
    }
}
exports.Client = Client;
