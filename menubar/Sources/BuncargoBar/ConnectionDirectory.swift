import Foundation

struct RemoteTarget: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let kind: String
    let `protocol`: String
    let status: String
    let preset: String?
    let port: Int
    let url: String
    let tablePlusUrl: String?

    var isHTTP: Bool { `protocol` == "http" }
    var state: RunStatus { RunStatus(rawValue: status) ?? .failed }
    var ready: Bool { status == "ready" || status == "reused" }
    var supportsTablePlus: Bool { tablePlusUrl != nil }
}

struct RemoteRun: Decodable, Identifiable, Sendable {
    let publisherId: String
    let sessionId: String
    let name: String
    let hostname: String
    let project: String
    let branch: String?
    let worktree: String?
    let primaryApp: String?
    let targets: [RemoteTarget]

    /// Two sandboxes can pick the same session id; the publisher is what makes a run unique.
    var id: String { "\(publisherId).\(sessionId)" }
    var title: String { branch ?? worktree ?? "Main" }
    var primary: RemoteTarget? {
        targets.first { $0.kind == "app" && $0.name == primaryApp && $0.isHTTP }
    }
}

struct ConnectionDirectory: Decodable, Sendable {
    let version: Int
    let configured: Bool
    let generatedAt: Double
    let notice: String?
    let runs: [RemoteRun]

    /// Every address the menu can act on has to point at this computer.
    ///
    /// A remote publisher names its own services, so the CLI derives the local
    /// address and this checks it again: CLI output is still an input boundary,
    /// and an action built from an unchecked string is an action on whatever a
    /// sandbox asked for.
    private static func validateLoopback(_ value: String, port: Int, allowCredentials: Bool)
        throws
    {
        guard let url = URL(string: value), url.host == "127.0.0.1", url.port == port,
            let scheme = url.scheme,
            ["http", "tcp", "postgresql", "redis", "clickhouse"].contains(scheme),
            url.fragment == nil,
            allowCredentials || url.query == nil,
            allowCredentials || (url.user == nil && url.password == nil),
            allowCredentials || url.path.isEmpty || url.path == "/"
        else {
            throw ConnectionError("Invalid local address")
        }
    }

    func validate(now: Date = Date()) throws {
        guard version == 1, generatedAt.isFinite,
            abs(generatedAt / 1000 - now.timeIntervalSince1970) < 30,
            runs.count <= 100, Set(runs.map(\.id)).count == runs.count,
            configured || runs.isEmpty
        else { throw ConnectionError("Invalid or stale connection directory") }

        for run in runs {
            guard run.publisherId.count == 64,
                run.publisherId.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                !run.sessionId.isEmpty, run.sessionId.count <= 256,
                !run.name.isEmpty, run.name.count <= 80, !run.hostname.isEmpty,
                !run.project.isEmpty, run.project.count <= 256, (run.branch?.count ?? 0) <= 256,
                (run.worktree?.count ?? 0) <= 256,
                run.targets.count <= 64, Set(run.targets.map(\.id)).count == run.targets.count
            else {
                throw ConnectionError("Invalid remote environment")
            }
            for target in run.targets {
                guard !target.id.isEmpty, target.id.count <= 256, !target.name.isEmpty,
                    target.name.count <= 256,
                    ["app", "service"].contains(target.kind),
                    ["http", "tcp"].contains(target.protocol),
                    ["starting", "ready", "reused", "stopped", "failed"].contains(target.status),
                    (1...65535).contains(target.port)
                else {
                    throw ConnectionError("Invalid remote service")
                }
                try Self.validateLoopback(
                    target.url, port: target.port, allowCredentials: !target.isHTTP)
                if let tablePlusUrl = target.tablePlusUrl {
                    guard !target.isHTTP else {
                        throw ConnectionError("Invalid database connection")
                    }
                    try Self.validateLoopback(
                        tablePlusUrl, port: target.port, allowCredentials: true)
                }
            }
            if let primary = run.primaryApp,
                !run.targets.contains(where: { $0.kind == "app" && $0.name == primary })
            {
                throw ConnectionError("Invalid primary app")
            }
        }
    }
}

struct ConnectionError: LocalizedError, Sendable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
