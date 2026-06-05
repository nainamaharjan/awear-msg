"use strict";
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
exports.Store = void 0;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
class Store {
    path;
    identity = null;
    // Default connectivity is ONLINE: a fresh client assumes the server is
    // reachable and discovers OFFLINE on the first network error (behavior.md §2).
    // The scenario's first commands run online without an explicit set-online true.
    online = true;
    outbox = [];
    cursor = 0;
    displayed_ids = [];
    constructor(storePath) {
        this.path = storePath;
    }
    /** Load persisted state from `storePath`, or start fresh if it is absent. */
    static async load(storePath) {
        const store = new Store(storePath);
        let raw;
        try {
            raw = await fs.readFile(storePath, "utf-8");
        }
        catch {
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
        }
        catch {
            // A corrupt store is treated as empty/fresh rather than crashing the
            // command; the atomic writes below make corruption unlikely anyway.
        }
        return store;
    }
    /** Atomically persist the current state to `this.path`. */
    async save() {
        const data = {
            identity: this.identity,
            online: this.online,
            outbox: this.outbox,
            cursor: this.cursor,
            displayed_ids: this.displayed_ids,
        };
        const dir = path.dirname(path.resolve(this.path));
        await fs.mkdir(dir, { recursive: true });
        const tmp = path.join(dir, `.store-${(0, node_crypto_1.randomBytes)(8).toString("hex")}.tmp`);
        try {
            await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
            await fs.rename(tmp, this.path);
        }
        catch (err) {
            // Best-effort cleanup of the temp file on any failure.
            try {
                await fs.unlink(tmp);
            }
            catch {
                /* ignore */
            }
            throw err;
        }
    }
}
exports.Store = Store;
