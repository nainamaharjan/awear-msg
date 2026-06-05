#!/usr/bin/env node
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

import { parseArgs } from "node:util";

import { Client } from "./core";
import * as store from "./store";

// Commands that require an established identity (control-interface.md §4).
const NEEDS_IDENTITY = new Set(["send", "flush", "poll", "set-online"]);
// Commands that contact the server and therefore need --server.
const NEEDS_SERVER = new Set(["login", "send", "flush", "poll", "set-online"]);

type DispatchError = { code: string; detail: string };

/** Print the single final JSON line and exit. */
function emit(payload: unknown, exitCode: number): never {
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.exit(exitCode);
}

function fail(code: string, detail: string, exitCode = 1): never {
  emit({ ok: false, error: code, detail }, exitCode);
}

function parseBool(value: string): boolean {
  const low = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(low)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(low)) {
    return false;
  }
  throw new Error(`expected true/false, got ${JSON.stringify(value)}`);
}

async function dispatch(
  command: string,
  args: string[],
  client: Client,
): Promise<{ result: unknown; err: null } | { result: null; err: DispatchError }> {
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
      let value: boolean;
      try {
        value = parseBool(args[0]);
      } catch (e) {
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

function ok(result: unknown): { result: unknown; err: null } {
  return { result, err: null };
}

function err(code: string, detail: string): { result: null; err: DispatchError } {
  return { result: null, err: { code, detail } };
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        server: { type: "string" },
        store: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch {
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
    fail(
      "no_server",
      `--server <url> is required for '${command}' (or set MSG_SERVER)`,
    );
  }

  let state: store.State;
  try {
    state = await store.load(storePath);
  } catch (e) {
    fail("store_error", `could not read store: ${e instanceof Error ? e.message : e}`);
  }

  // Identity precondition (control-interface.md §4).
  if (NEEDS_IDENTITY.has(command) && !state.identity) {
    fail(
      "no_identity",
      `'${command}' requires an established identity; run login first`,
    );
  }

  const client = new Client(state, server ?? "");

  let outcome;
  try {
    outcome = await dispatch(command, cmdArgs, client);
  } catch (e) {
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
  } catch (e) {
    fail("store_error", `could not write store: ${e instanceof Error ? e.message : e}`);
  }

  emit(outcome.result, 0);
}

main().catch((e) => {
  // Defensive: any escape from main() still yields a structured final line.
  fail("internal_error", `${e instanceof Error ? e.name + ": " + e.message : String(e)}`);
});
