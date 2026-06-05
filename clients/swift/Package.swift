// swift-tools-version:5.9
//
// SwiftPM manifest for the headless messaging client (spec/platform/swift.md).
// One executable target, ZERO third-party dependencies — only the standard
// library and Foundation are used. Pinned to the Swift 5.9 tools version so the
// synchronous DispatchSemaphore HTTP wrapper compiles without Swift 6 strict
// concurrency friction, while still building on a 6.x toolchain.
import PackageDescription

let package = Package(
    name: "messaging-client",
    targets: [
        .executableTarget(
            name: "messaging-client",
            dependencies: [],
            path: "Sources/messaging-client"
        )
    ]
)
