// main.swift — CLI entrypoint: argument parsing + one-shot command dispatch.
//
// Launch string (spec/platform/swift.md): `.build/release/messaging-client`.
//
// Execution model (control-interface.md §1): load state from `--store`, run
// exactly one command, persist atomically, print exactly one JSON object as the
// final stdout line, exit 0 on success / non-zero on failure. Any unhandled error
// is still reported as a structured `internal_error` rather than a crashing stack
// trace (control-interface.md §3).

import Foundation

// Commands that require an established identity (control-interface.md §4).
let needsIdentity: Set<String> = ["send", "flush", "poll", "set-online"]
// Commands that contact the server and therefore need --server (dump-state does
// not; control-interface.md §4.6).
let needsServer: Set<String> = ["login", "send", "flush", "poll", "set-online"]

/// Print the single final JSON line (sorted keys for stable output) and exit.
func emit(_ payload: [String: Any], _ code: Int32) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    } else {
        print(#"{"ok":false,"error":"internal_error","detail":"could not serialize output"}"#)
    }
    exit(code)
}

func fail(_ code: String, _ detail: String, _ exitCode: Int32 = 1) -> Never {
    emit(["ok": false, "error": code, "detail": detail], exitCode)
}

func parseBool(_ value: String) throws -> Bool {
    switch value.trimmingCharacters(in: .whitespaces).lowercased() {
    case "true", "1", "yes", "on": return true
    case "false", "0", "no", "off": return false
    default:
        throw NetworkError(message: "expected true/false, got \(value)")
    }
}

// --- argument parsing --------------------------------------------------------
let env = ProcessInfo.processInfo.environment
var server: String? = env["MSG_SERVER"]
var store: String? = env["MSG_STORE"]
var positionals: [String] = []

let argv = CommandLine.arguments
var i = 1
while i < argv.count {
    let a = argv[i]
    if a == "--server" {
        i += 1
        server = i < argv.count ? argv[i] : nil
    } else if a.hasPrefix("--server=") {
        server = String(a.dropFirst("--server=".count))
    } else if a == "--store" {
        i += 1
        store = i < argv.count ? argv[i] : nil
    } else if a.hasPrefix("--store=") {
        store = String(a.dropFirst("--store=".count))
    } else {
        positionals.append(a)
    }
    i += 1
}

guard let command = positionals.first else {
    fail("bad_args", "a command is required", 2)
}
let cmdArgs = Array(positionals.dropFirst())

guard let storePath = store else {
    fail("no_store", "--store <path> is required (or set MSG_STORE)")
}

if needsServer.contains(command) && (server == nil || server!.isEmpty) {
    fail("no_server", "--server <url> is required for '\(command)' (or set MSG_SERVER)")
}

// Load persisted state.
let state: State
do {
    state = try Store.load(storePath)
} catch {
    fail("store_error", "could not read store: \(error)")
}

// Identity precondition (control-interface.md §4).
if needsIdentity.contains(command) && (state.identity == nil) {
    fail("no_identity", "'\(command)' requires an established identity; run login first")
}

let client = Client(state: state, server: server ?? "")

// --- dispatch ----------------------------------------------------------------
// `dump-state` is purely local and persists nothing; every other command runs,
// then we persist atomically before emitting (control-interface.md §1, §5).
do {
    let result: [String: Any]
    var persist = true

    switch command {
    case "login":
        guard cmdArgs.count == 1 else {
            fail("bad_args", "login requires exactly one argument: <name>")
        }
        result = try client.login(cmdArgs[0])

    case "send":
        guard cmdArgs.count == 2 else {
            fail("bad_args", "send requires two arguments: <to> <body>")
        }
        result = try client.send(to: cmdArgs[0], body: cmdArgs[1])

    case "flush":
        let flushed = try client.flush()
        result = ["ok": true, "flushed": flushed, "remaining": client.state.outbox.count]

    case "poll":
        let received = try client.poll()
        result = ["ok": true,
                  "received": received.map { $0.asDict },
                  "cursor": client.state.cursor]

    case "set-online":
        guard cmdArgs.count == 1 else {
            fail("bad_args", "set-online requires one argument: <true|false>")
        }
        let value: Bool
        do {
            value = try parseBool(cmdArgs[0])
        } catch {
            fail("bad_args", "set-online expects true/false, got '\(cmdArgs[0])'")
        }
        result = try client.setOnline(value)

    case "dump-state":
        result = client.dumpState()
        persist = false

    default:
        fail("unknown_command", "no such command: \(command)")
    }

    if persist {
        do {
            try Store.save(storePath, client.state)
        } catch {
            fail("store_error", "could not write store: \(error)")
        }
    }

    emit(result, 0)
} catch {
    // Last-resort structured failure (control-interface.md §3).
    fail("internal_error", "\(error)")
}
