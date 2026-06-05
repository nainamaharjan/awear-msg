#!/usr/bin/env node
"use strict";
/**
 * CLI entrypoint: argument parsing + one-shot command dispatch.
 *
 * Launch string (spec/platform/typescript.md): `node dist/cli.js`.
 *
 * Execution model (control-interface.md §1): load state from `--store`, run
 * exactly one command, persist, print exactly one JSON object as the final
 * stdout line, exit 0 on success / non-zero on failure. Any unhandled error is
 * still reported as a structured `internal_error` rather than a crashing stack
 * trace (control-interface.md §3).
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
const node_util_1 = require("node:util");
const core_1 = require("./core");
const store = __importStar(require("./store"));
// Commands that require an established identity (control-interface.md §4).
const NEEDS_IDENTITY = new Set(["send", "flush", "poll", "set-online"]);
// Commands that contact the server and therefore need --server.
const NEEDS_SERVER = new Set(["login", "send", "flush", "poll", "set-online"]);
/** Print the single final JSON line and exit. */
function emit(payload, exitCode) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    process.exit(exitCode);
}
function fail(code, detail, exitCode = 1) {
    emit({ ok: false, error: code, detail }, exitCode);
}
function parseBool(value) {
    const low = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(low)) {
        return true;
    }
    if (["false", "0", "no", "off"].includes(low)) {
        return false;
    }
    throw new Error(`expected true/false, got ${JSON.stringify(value)}`);
}
async function dispatch(command, args, client) {
    switch (command) {
        case "login": {
            if (args.length !== 1) {
                return err("bad_args", "login requires exactly one argument: <name>");
            }
            return ok(await client.login(args[0]));
        }
        case "send": {
            if (args.length !== 2) {
                return err("bad_args", "send requires two arguments: <to> <body>");
            }
            return ok(await client.send(args[0], args[1]));
        }
        case "flush": {
            const flushed = await client.flush();
            return ok({
                ok: true,
                flushed,
                remaining: client.state.outbox.length,
            });
        }
        case "poll": {
            const received = await client.poll();
            return ok({ ok: true, received, cursor: client.state.cursor });
        }
        case "set-online": {
            if (args.length !== 1) {
                return err("bad_args", "set-online requires one argument: <true|false>");
            }
            let value;
            try {
                value = parseBool(args[0]);
            }
            catch (e) {
                return err("bad_args", e instanceof Error ? e.message : String(e));
            }
            return ok(await client.set_online(value));
        }
        case "dump-state": {
            return ok(client.dump_state());
        }
        default:
            return err("unknown_command", `no such command: ${command}`);
    }
}
function ok(result) {
    return { result, err: null };
}
function err(code, detail) {
    return { result: null, err: { code, detail } };
}
async function main() {
    let parsed;
    try {
        parsed = (0, node_util_1.parseArgs)({
            options: {
                server: { type: "string" },
                store: { type: "string" },
            },
            allowPositionals: true,
        });
    }
    catch {
        fail("bad_args", "could not parse arguments", 2);
    }
    const positionals = parsed.positionals;
    const command = positionals[0];
    const cmdArgs = positionals.slice(1);
    if (!command) {
        fail("bad_args", "a command is required", 2);
    }
    const server = parsed.values.server ?? process.env.MSG_SERVER;
    const storePath = parsed.values.store ?? process.env.MSG_STORE;
    if (!storePath) {
        fail("no_store", "--store <path> is required (or set MSG_STORE)");
    }
    if (NEEDS_SERVER.has(command) && !server) {
        fail("no_server", `--server <url> is required for '${command}' (or set MSG_SERVER)`);
    }
    let state;
    try {
        state = await store.load(storePath);
    }
    catch (e) {
        fail("store_error", `could not read store: ${e instanceof Error ? e.message : e}`);
    }
    // Identity precondition (control-interface.md §4).
    if (NEEDS_IDENTITY.has(command) && !state.identity) {
        fail("no_identity", `'${command}' requires an established identity; run login first`);
    }
    const client = new core_1.Client(state, server ?? "");
    let outcome;
    try {
        outcome = await dispatch(command, cmdArgs, client);
    }
    catch (e) {
        // Last-resort structured failure (control-interface.md §3).
        fail("internal_error", `${e instanceof Error ? e.name + ": " + e.message : String(e)}`);
    }
    if (outcome.err) {
        // No persistence on a usage error: state was not meaningfully changed.
        fail(outcome.err.code, outcome.err.detail);
    }
    // Persist all state changes before printing (control-interface.md §5).
    try {
        await store.save(storePath, client.state);
    }
    catch (e) {
        fail("store_error", `could not write store: ${e instanceof Error ? e.message : e}`);
    }
    emit(outcome.result, 0);
}
main().catch((e) => {
    // Defensive: any escape from main() still yields a structured final line.
    fail("internal_error", `${e instanceof Error ? e.name + ": " + e.message : String(e)}`);
});
