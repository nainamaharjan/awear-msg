#!/usr/bin/env node
"use strict";
/**
 * CLI entry point: argument parsing and command dispatch.
 *
 * Realizes the control interface (control-interface.md). Launch string:
 * `node dist/cli.js` (spec/platform/typescript.md). One command per process; the
 * final line of stdout is exactly one JSON object; exit 0 on success, non-zero on
 * failure.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_util_1 = require("node:util");
const core_1 = require("./core");
const protocol_1 = require("./protocol");
const store_1 = require("./store");
/**
 * Print the single JSON result line and record the exit code.
 *
 * We set `process.exitCode` and return rather than calling `process.exit()`:
 * `process.exit()` can truncate a not-yet-flushed stdout when it is a pipe (as
 * the conformance harness uses it). The process exits naturally with this code
 * once the event loop drains and stdout is fully written.
 */
function emit(payload, exitCode) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    process.exitCode = exitCode;
}
function fail(code, detail, exitCode = 1) {
    emit({ ok: false, error: code, detail }, exitCode);
}
/** Project messages to the `received` shape (control-interface.md §4.4). */
function receivedView(messages) {
    return messages.map((m) => ({
        id: m.id,
        from: m.from,
        body: m.body,
        delivery_seq: m.delivery_seq,
    }));
}
function parseBool(flag) {
    const value = flag.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(value))
        return true;
    if (["false", "0", "no", "off"].includes(value))
        return false;
    throw new Error(`expected true/false, got ${JSON.stringify(flag)}`);
}
async function dispatch() {
    let parsed;
    try {
        parsed = (0, node_util_1.parseArgs)({
            args: process.argv.slice(2),
            options: {
                server: { type: "string" },
                store: { type: "string" },
            },
            allowPositionals: true,
            strict: true,
        });
    }
    catch (err) {
        return fail("bad_args", err instanceof Error ? err.message : String(err), 2);
    }
    const serverUrl = parsed.values.server ?? process.env.MSG_SERVER;
    const storePath = parsed.values.store ?? process.env.MSG_STORE;
    const positionals = parsed.positionals;
    const command = positionals[0];
    if (!command) {
        return fail("bad_args", "a command is required", 2);
    }
    if (!storePath) {
        return fail("bad_args", "--store is required (or set MSG_STORE)", 2);
    }
    // dump-state is purely local and does not contact the server, so --server is
    // optional for it only (control-interface.md §4.6). Every other command needs
    // a server URL.
    if (command !== "dump-state" && !serverUrl) {
        return fail("bad_args", "--server is required (or set MSG_SERVER)", 2);
    }
    const store = await store_1.Store.load(storePath);
    const server = serverUrl ? new protocol_1.Server(serverUrl) : null;
    const client = new core_1.Client(store, server);
    switch (command) {
        case "login": {
            const name = positionals[1];
            if (name === undefined)
                return fail("bad_args", "login requires a <name>", 2);
            const user = await client.login(name);
            return emit({ ok: true, user }, 0);
        }
        case "send": {
            const to = positionals[1];
            const body = positionals[2];
            if (to === undefined || body === undefined) {
                return fail("bad_args", "send requires <to> and <body>", 2);
            }
            const [id, sent, remaining] = await client.send(to, body);
            return emit({ ok: true, id, sent, queued_remaining: remaining }, 0);
        }
        case "flush": {
            const flushed = await client.flush();
            return emit({ ok: true, flushed, remaining: store.outbox.length }, 0);
        }
        case "poll": {
            const received = await client.poll();
            return emit({ ok: true, received: receivedView(received), cursor: store.cursor }, 0);
        }
        case "set-online": {
            const flag = positionals[1];
            if (flag === undefined) {
                return fail("bad_args", "set-online requires <true|false>", 2);
            }
            let online;
            try {
                online = parseBool(flag);
            }
            catch (err) {
                return fail("bad_args", err instanceof Error ? err.message : String(err), 2);
            }
            const [flushed, received] = await client.setOnline(online);
            return emit({ ok: true, online, flushed, received: receivedView(received) }, 0);
        }
        case "dump-state": {
            const outboxView = store.outbox.map((m) => ({
                id: m.id,
                to: m.to,
                body: m.body,
            }));
            return emit({
                ok: true,
                identity: store.identity,
                online: store.online,
                outbox: outboxView,
                cursor: store.cursor,
                displayed_ids: [...store.displayed_ids],
            }, 0);
        }
        default:
            return fail("bad_args", `unknown command: ${command}`, 2);
    }
}
async function main() {
    try {
        await dispatch();
    }
    catch (err) {
        if (err instanceof core_1.NoIdentityError) {
            fail("no_identity", err.message, 1);
        }
        else if (err instanceof protocol_1.ProtocolError) {
            // Server reachable but rejected the request (protocol.md §6).
            fail(err.code, err.detail, 1);
        }
        else if (err instanceof protocol_1.NetworkError) {
            // Should normally be caught and turned into an OFFLINE transition inside
            // core; surfacing here is a defensive backstop.
            fail("network_error", err.message, 1);
        }
        else {
            // control-interface.md §3 backstop: never a raw crash as the final line.
            const name = err instanceof Error ? err.name : "Error";
            const message = err instanceof Error ? err.message : String(err);
            fail("internal_error", `${name}: ${message}`, 1);
        }
    }
}
main();
