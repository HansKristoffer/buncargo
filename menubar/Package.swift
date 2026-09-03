// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BuncargoBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "BuncargoBar",
            path: "Sources/BuncargoBar"
        )
    ]
)
