// Core.swift — the offline state machine: send / flush / poll / reconnect
// (behavior.md §3).
//
// `Client` operates on an in-memory copy of the persisted `State`. Each control
// command mutates the state; the caller (main.swift) persists once atomically at
// the end of the command. Because each invocation runs exactly one command in its
// own process (control-interface.md §1), a single save at the end preserves the
// no-loss invariant: either the whole command's effect is durable or none of it
// is. If the process dies after a successful POST but before the save, the message
// is still in the outbox and is re-sent next run; the server dedups on `id`
// (protocol.md §4.2), so it is neither lost nor displayed twice.
//
// Connectivity is a persisted flag that gates all network I/O (behavior.md §2). A
// network error during any request flips the flag to OFFLINE.

import Foundation

/// One newly displayed message, as reported by `poll`/`set-online`
/// (control-interface.md §4.4).
struct ReceivedMessage {
    let id: String
    let from: String
    let body: String
    let deliverySeq: Int

    var asDict: [String: Any] {
        ["id": id, "from": from, "body": body, "delivery_seq": deliverySeq]
    }
}

final class Client {
    var state: State
    private let server: String

    init(state: State, server: String) {
        self.state = state
        self.server = ProtocolClient.normalize(server)
    }

    var online: Bool { state.online }

    private func goOffline() { state.online = false }

    // --- login (control-interface.md §4.1) -------------------------------
    func login(_ name: String) throws -> [String: Any] {
        state.identity = name
        if online {
            do {
                _ = try ProtocolClient.postSession(server, name: name)
                // Any successful request implies ONLINE; nothing else to do.
            } catch is NetworkError {
                goOffline()
            }
        }
        return ["ok": true, "user": name]
    }

    // --- send (control-interface.md §4.2, behavior.md §3.1) --------------
    func send(to: String, body: String) throws -> [String: Any] {
        let message = Message(
            id: UUID().uuidString,
            from: state.identity ?? "",
            to: to,
            body: body,
            sentAt: ISO8601DateFormatter().string(from: Date()),
            deliverySeq: nil
        )
        // Enqueue first and (the caller will) persist — this is what guarantees
        // no loss when offline.
        state.outbox.append(message)

        if online {
            _ = try flush()
        }

        let stillQueued = state.outbox.contains { $0.id == message.id }
        return [
            "ok": true,
            "id": message.id,
            "sent": !stillQueued,
            "queued_remaining": state.outbox.count,
        ]
    }

    // --- flush (control-interface.md §4.3, behavior.md §3.2) -------------
    /// Drain the outbox oldest-first. Returns the count flushed this call.
    @discardableResult
    func flush() throws -> Int {
        var flushed = 0
        if !online { return flushed } // OFFLINE gates network I/O.

        while let message = state.outbox.first {
            let result: HttpResult
            do {
                result = try ProtocolClient.postMessage(server, message: message)
            } catch is NetworkError {
                // behavior.md §3.2 step 3: go OFFLINE and stop; order preserved.
                goOffline()
                break
            }

            let ack = (try? JSONDecoder().decode(AckResponse.self, from: result.body))?.status
            if (result.status == 202 || result.status == 200)
                && (ack == "accepted" || ack == "duplicate") {
                // accepted or duplicate both mean "the server has it" -> drop it.
                state.outbox.removeFirst()
                flushed += 1
            } else {
                // behavior.md §3.2 step 4: reachable but rejected. Keep the
                // message, stay ONLINE, stop the flush. (Should not happen for
                // well-formed messages.)
                break
            }
        }
        return flushed
    }

    // --- poll (control-interface.md §4.4, behavior.md §3.3) -------------
    /// Fetch new messages, display (dedup by id), advance the cursor. Returns the
    /// newly displayed messages in delivery_seq order.
    func poll() throws -> [ReceivedMessage] {
        var received: [ReceivedMessage] = []
        if !online { return received } // poll only runs while ONLINE.

        let result: HttpResult
        do {
            result = try ProtocolClient.getMessages(
                server, user: state.identity ?? "", after: state.cursor)
        } catch is NetworkError {
            goOffline()
            return received
        }

        guard result.status == 200,
              let payload = try? JSONDecoder().decode(PollResponse.self, from: result.body)
        else {
            // Reachable but errored/unparseable; leave cursor untouched.
            return received
        }

        var displayed = Set(state.displayedIds)
        let ordered = payload.messages.sorted {
            ($0.deliverySeq ?? 0) < ($1.deliverySeq ?? 0)
        }
        for m in ordered where !displayed.contains(m.id) {
            received.append(ReceivedMessage(
                id: m.id, from: m.from, body: m.body, deliverySeq: m.deliverySeq ?? 0))
            displayed.insert(m.id)
        }

        state.cursor = payload.cursor
        state.displayedIds = Array(displayed)
        return received
    }

    // --- set-online (control-interface.md §4.5, behavior.md §3.4) -------
    func setOnline(_ value: Bool) throws -> [String: Any] {
        let wasOnline = online
        state.online = value

        var flushed = 0
        var received: [ReceivedMessage] = []
        if value && !wasOnline {
            // Genuine OFFLINE -> ONLINE transition: reconnect = flush then poll.
            flushed = try flush()
            received = try poll()
        }

        return [
            "ok": true,
            // Report the actual flag: flush/poll may have flipped it back to
            // OFFLINE if the server turned out to be unreachable.
            "online": online,
            "flushed": flushed,
            "received": received.map { $0.asDict },
        ]
    }

    // --- dump-state (control-interface.md §4.6) -------------------------
    func dumpState() -> [String: Any] {
        let identityValue: Any = state.identity ?? NSNull()
        return [
            "ok": true,
            "identity": identityValue,
            "online": online,
            "outbox": state.outbox.map { ["id": $0.id, "to": $0.to, "body": $0.body] },
            "cursor": state.cursor,
            "displayed_ids": state.displayedIds,
        ]
    }
}
