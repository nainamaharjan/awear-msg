// Protocol.swift — wire protocol: HTTP calls and (de)serialization.
//
// Implements the three endpoints from spec/protocol.md using `URLSession`. The
// client is one-shot, so each call blocks on a DispatchSemaphore until the single
// request completes (spec/platform/swift.md). Every request carries
// `X-Protocol-Version: 1`.
//
// Two failure modes are distinguished, because behavior.md treats them
// differently:
//   - NetworkError      — the server is unreachable (connection refused, DNS,
//                         timeout). Callers transition to OFFLINE (behavior.md §2).
//   - an HTTP non-2xx   — the server is reachable but rejected the request. This
//                         is returned as a normal HttpResult so the caller can
//                         apply behavior.md §3.2 step 4 (do NOT go offline).

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Server unreachable. Triggers the OFFLINE transition (behavior.md §2).
struct NetworkError: Error {
    let message: String
}

/// A reachable HTTP response: status code plus the raw body bytes.
struct HttpResult {
    let status: Int
    let body: Data
}

/// Acknowledgement payload of `POST /messages` (protocol.md §4.2).
struct AckResponse: Decodable {
    let status: String?
}

/// Response payload of `GET /messages` (protocol.md §4.3).
struct PollResponse: Decodable {
    let messages: [Message]
    let cursor: Int
}

enum ProtocolClient {
    static let version = "1"
    static let timeout: TimeInterval = 10 // a hung connection becomes a NetworkError

    /// Strip any trailing slashes from the supplied base URL (protocol.md §1).
    static func normalize(_ server: String) -> String {
        var s = server
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// Blocking HTTP request. Returns an HttpResult for any received response
    /// (including non-2xx); throws NetworkError only when no response arrives.
    private static func request(
        method: String, url: URL, body: Data?
    ) throws -> HttpResult {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(version, forHTTPHeaderField: "X-Protocol-Version")
        if let body = body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        req.timeoutInterval = timeout

        let sem = DispatchSemaphore(value: 0)
        var result: HttpResult?
        var transportError: Error?

        let task = URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err = err {
                transportError = err
            } else if let http = resp as? HTTPURLResponse {
                result = HttpResult(status: http.statusCode, body: data ?? Data())
            } else {
                transportError = NetworkError(message: "no HTTP response")
            }
            sem.signal()
        }
        task.resume()
        sem.wait()

        if let err = transportError {
            throw NetworkError(message: (err as? NetworkError)?.message
                ?? (err as NSError).localizedDescription)
        }
        guard let result = result else {
            throw NetworkError(message: "no response")
        }
        return result
    }

    /// POST /session — log in by name (protocol.md §4.1).
    static func postSession(_ server: String, name: String) throws -> HttpResult {
        let url = URL(string: "\(server)/session")!
        let body = try JSONSerialization.data(withJSONObject: ["name": name])
        return try request(method: "POST", url: url, body: body)
    }

    /// POST /messages — send one message (protocol.md §4.2). The message must
    /// already carry id/from/to/body/sent_at and NO delivery_seq.
    static func postMessage(_ server: String, message: Message) throws -> HttpResult {
        let url = URL(string: "\(server)/messages")!
        let body = try JSONEncoder().encode(message)
        return try request(method: "POST", url: url, body: body)
    }

    /// GET /messages — poll for messages addressed to `user` (protocol.md §4.3).
    static func getMessages(_ server: String, user: String, after: Int) throws -> HttpResult {
        var comps = URLComponents(string: "\(server)/messages")!
        comps.queryItems = [
            URLQueryItem(name: "user", value: user),
            URLQueryItem(name: "after", value: String(after)),
        ]
        return try request(method: "GET", url: comps.url!, body: nil)
    }
}
