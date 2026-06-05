// Store.swift — persistent client state (behavior.md §1).
//
// The `--store` path is a single JSON file holding the entire client state. It
// MUST survive process restart (this is the whole point of the offline outbox),
// so writes are atomic via `Data.write(to:options:.atomic)` (spec/platform/
// swift.md): Foundation writes to a temp file and renames it over the target, so
// a crash mid-write leaves the previous good file intact.
//
// State shape:
//   identity      : String?   -- logged-in user name (nil until login)
//   online        : Bool      -- persisted connectivity flag (control-interface)
//   outbox        : [Message] -- composed-but-unacked messages, FIFO oldest-first
//   cursor        : Int       -- highest delivery_seq fetched + displayed
//   displayed_ids : [String]  -- ids already shown to the user (display dedup)

import Foundation

/// A message in the wire schema (protocol.md §3). `deliverySeq` is server-set and
/// is absent on an outbox message; the synthesized encoder omits nil optionals,
/// so encoding an outbox message for `POST /messages` correctly leaves it out.
struct Message: Codable {
    let id: String
    let from: String
    let to: String
    let body: String
    let sentAt: String
    var deliverySeq: Int?

    enum CodingKeys: String, CodingKey {
        case id, from, to, body
        case sentAt = "sent_at"
        case deliverySeq = "delivery_seq"
    }
}

/// Whole persisted client state. Defaults: a fresh client is ONLINE with no
/// identity, an empty outbox and a zero cursor (behavior.md §1).
struct State: Codable {
    var identity: String?
    var online: Bool
    var outbox: [Message]
    var cursor: Int
    var displayedIds: [String]

    enum CodingKeys: String, CodingKey {
        case identity, online, outbox, cursor
        case displayedIds = "displayed_ids"
    }

    static func makeDefault() -> State {
        State(identity: nil, online: true, outbox: [], cursor: 0, displayedIds: [])
    }
}

enum Store {
    /// Load state from `path`, returning defaults if the file does not exist yet.
    static func load(_ path: String) throws -> State {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else {
            return State.makeDefault()
        }
        let data = try Data(contentsOf: url)
        if data.isEmpty { return State.makeDefault() }
        return try JSONDecoder().decode(State.self, from: data)
    }

    /// Atomically persist `state` to `path`. Creates parent directories as needed.
    static func save(_ path: String, _ state: State) throws {
        let url = URL(fileURLWithPath: path)
        let dir = url.deletingLastPathComponent()
        if !dir.path.isEmpty {
            try FileManager.default.createDirectory(
                at: dir, withIntermediateDirectories: true)
        }
        let encoder = JSONEncoder()
        let data = try encoder.encode(state)
        try data.write(to: url, options: .atomic)
    }
}
