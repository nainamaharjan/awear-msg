# Platform Mapping: Swift

How the Swift client realizes the generic specs (`protocol.md`, `behavior.md`,
`control-interface.md`). The agent generating `clients/swift/` MUST follow this.
Generic behavior is fixed by those specs; this file only fixes *how Swift does it*.

The Swift client is a **headless command-line executable** (Swift Package Manager),
not an iOS/macOS app. It runs from the terminal, reads arguments, and prints JSON to
stdout — the same control interface as the other clients — so the conformance runner
drives it identically.

## Runtime & dependencies
- Swift 5.9+ (works on macOS and Linux via the open-source toolchain). Pin and
  document the exact toolchain version in the client README; on Linux, install from
  swift.org.
- **No third-party package dependencies.** Use only the standard library and
  `Foundation`. On Linux, `URLSession` lives in `FoundationNetworking`, so guard the
  import:
  ```swift
  #if canImport(FoundationNetworking)
  import FoundationNetworking
  #endif
  ```
- `Package.swift` declares one `executableTarget` and an empty `dependencies` array.

## Project layout & entrypoint
- A SwiftPM executable named `messaging-client`.
- **Build step:** `swift build -c release`.
- Control-interface launch string (control-interface.md §2):
  `.build/release/messaging-client` (run the compiled binary so there is no build
  noise on stdout, mirroring the TypeScript `dist/` approach).
- Suggested layout:
  ```
  clients/swift/
    Package.swift
    Sources/messaging-client/
      main.swift        # arg parsing + command dispatch + final JSON line
      Protocol.swift    # URLSession calls; Codable wire models
      Store.swift       # load/save persistent state (atomic)
      Core.swift        # offline state machine
    README.md           # build & run commands
  ```

## Concrete choices
- **HTTP:** `URLSession` (with the `FoundationNetworking` import on Linux). Send
  `X-Protocol-Version: 1` on every request. The client is one-shot, so block until
  the single request completes — either via `async`/`await` in an async entrypoint
  or a `DispatchSemaphore`-based synchronous wrapper, whichever is cleaner. Treat a
  transport failure (no response) as the OFFLINE transition; treat a reachable
  non-2xx response as a protocol error (behavior.md §3.2).
- **JSON:** `Codable` structs with `JSONEncoder`/`JSONDecoder`. Map the snake_case
  wire field `delivery_seq` to a Swift property via `CodingKeys` (or
  `keyDecodingStrategy = .convertFromSnakeCase`). `from`/`to`/`body`/`id`/`sent_at`
  map directly.
- **Storage:** the `--store` path is a JSON file. Encode the state struct and write
  **atomically** with `Data.write(to:options:.atomic)`; decode it on load. Holds
  `identity`, `online`, `outbox`, `cursor`, `displayed_ids`.
- **UUID:** `UUID().uuidString` for message `id`.
- **Timestamps:** `ISO8601DateFormatter().string(from: Date())` for `sent_at`.
- **CLI parsing:** parse `CommandLine.arguments` directly (no third-party argument
  parser, to keep zero dependencies). Support global `--server` / `--store`, the
  positional command and its args, and env fallback `MSG_SERVER` / `MSG_STORE`.
- **Output:** print exactly one JSON object as the final stdout line
  (control-interface.md §3); exit `0` on success, non-zero on error (`exit(1)`).
  Unexpected errors still produce a structured `internal_error` object.

## Run / build
- Build: `swift build -c release`
- Run: `.build/release/messaging-client --server <url> --store <path> <cmd> [args]`