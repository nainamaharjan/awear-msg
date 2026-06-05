"use strict";
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
exports.defaultState = defaultState;
exports.load = load;
exports.save = save;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const path = __importStar(require("node:path"));
function defaultState() {
    return {
        identity: null,
        online: true, // a fresh client is ONLINE until told otherwise
        outbox: [],
        cursor: 0,
        displayed_ids: [],
    };
}
/** Load state from `path`, returning defaults if it does not exist yet. */
async function load(storePath) {
    const state = defaultState();
    if (!storePath) {
        return state;
    }
    let raw;
    try {
        raw = await (0, promises_1.readFile)(storePath, "utf-8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return state; // no store yet -> defaults
        }
        throw err;
    }
    const data = JSON.parse(raw);
    // Merge over defaults so a partial/older file still yields every key.
    if (data && typeof data === "object") {
        const mutable = state;
        for (const key of Object.keys(state)) {
            if (key in data) {
                mutable[key] = data[key];
            }
        }
    }
    return state;
}
/** Atomically persist `state` to `path`. */
async function save(storePath, state) {
    const target = path.resolve(storePath);
    const directory = path.dirname(target);
    await (0, promises_1.mkdir)(directory, { recursive: true });
    const tmp = path.join(directory, `.store-${process.pid}-${(0, node_crypto_1.randomBytes)(6).toString("hex")}.tmp`);
    try {
        await (0, promises_1.writeFile)(tmp, JSON.stringify(state), "utf-8");
        await (0, promises_1.rename)(tmp, target);
    }
    catch (err) {
        try {
            await (0, promises_1.unlink)(tmp);
        }
        catch {
            /* best-effort cleanup */
        }
        throw err;
    }
}
