"use strict";
/**
 * Wire protocol: HTTP calls and message (de)serialization.
 *
 * Implements the three endpoints from `spec/protocol.md` using only built-ins
 * (global `fetch` + `JSON`), as required by `spec/platform/typescript.md`.
 *
 * This module's single responsibility is to turn protocol intent into HTTP and
 * back. It deliberately knows nothing about the offline state machine (that lives
 * in `core.ts`) or persistence (`store.ts`).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Server = exports.ProtocolError = exports.NetworkError = exports.MAX_BODY_BYTES = exports.PROTOCOL_VERSION = void 0;
exports.nowIso = nowIso;
exports.PROTOCOL_VERSION = "1";
/** Max body size from protocol.md §3 (the message `body` field). */
exports.MAX_BODY_BYTES = 4096;
/**
 * The server was unreachable (connection refused, timeout, DNS, etc.).
 *
 * Per behavior.md §2 this is the signal to transition the client to OFFLINE.
 * It is distinct from a reachable-server error response (see `ProtocolError`).
 */
class NetworkError extends Error {
    constructor(message) {
        super(message);
        this.name = "NetworkError";
    }
}
exports.NetworkError = NetworkError;
/**
 * The server was reachable but returned a non-2xx response.
 *
 * Carries the HTTP status and the parsed error envelope (protocol.md §6). This
 * does NOT imply offline — the server answered (behavior.md §3.2 step 4).
 */
class ProtocolError extends Error {
    status;
    code;
    detail;
    constructor(status, code, detail) {
        super(`${code}: ${detail}`);
        this.name = "ProtocolError";
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}
exports.ProtocolError = ProtocolError;
/** RFC 3339 / ISO 8601 UTC timestamp for a message's `sent_at`. */
function nowIso() {
    return new Date().toISOString();
}
/** Thin HTTP client bound to a single server base URL. */
class Server {
    baseUrl;
    timeoutMs;
    constructor(baseUrl, timeoutMs = 10000) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.timeoutMs = timeoutMs;
    }
    // --- low-level request --------------------------------------------------
    async request(method, path, body) {
        const url = `${this.baseUrl}${path}`;
        const headers = {
            "X-Protocol-Version": exports.PROTOCOL_VERSION,
        };
        let data;
        if (body !== undefined) {
            data = JSON.stringify(body);
            headers["Content-Type"] = "application/json";
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let resp;
        try {
            resp = await fetch(url, {
                method,
                headers,
                body: data,
                signal: controller.signal,
            });
        }
        catch (err) {
            // fetch rejects only on a genuine network failure (refused, DNS, abort,
            // timeout): the server is unreachable -> OFFLINE transition (behavior.md §2).
            const reason = err instanceof Error ? err.message : String(err);
            throw new NetworkError(reason);
        }
        finally {
            clearTimeout(timer);
        }
        const raw = await resp.text();
        let payload = {};
        if (raw) {
            try {
                payload = JSON.parse(raw);
            }
            catch {
                payload = {};
            }
        }
        if (!resp.ok) {
            // The server responded with a non-2xx status: reachable, so this is a
            // ProtocolError, not a NetworkError.
            const code = (payload && typeof payload.error === "string" && payload.error) ||
                "http_error";
            const detail = (payload && typeof payload.detail === "string" && payload.detail) ||
                `HTTP ${resp.status}`;
            throw new ProtocolError(resp.status, code, detail);
        }
        return { status: resp.status, payload };
    }
    // --- endpoints (protocol.md §4) -----------------------------------------
    /** POST /session — idempotent login by name (protocol.md §4.1). */
    async login(name) {
        const { payload } = await this.request("POST", "/session", { name });
        return payload;
    }
    /**
     * POST /messages — send one message (protocol.md §4.2).
     *
     * Returns `[delivered, delivery_seq]`. `delivered` is true for both a
     * `202 accepted` and a `200 duplicate` — both mean the server holds the
     * message, so the outbox entry can be dropped (behavior.md §3.2 step 2).
     */
    async send(message) {
        const { payload } = await this.request("POST", "/messages", message);
        return [true, Number(payload?.delivery_seq ?? 0)];
    }
    /** GET /messages — poll for messages after a cursor (protocol.md §4.3). */
    async fetchMessages(user, after) {
        const path = `/messages?user=${encodeURIComponent(user)}&after=${Math.trunc(after)}`;
        const { payload } = await this.request("GET", path);
        const messages = Array.isArray(payload?.messages)
            ? payload.messages
            : [];
        const cursor = Number(payload?.cursor ?? after);
        return [messages, cursor];
    }
}
exports.Server = Server;
