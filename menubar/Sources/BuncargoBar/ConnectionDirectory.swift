import Foundation

struct RemoteTarget: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    let kind: String
    let `protocol`: String
    let status: String
    let preset: String?
    var isHTTP: Bool { `protocol` == "http" }
    var isPostgres: Bool { preset == "postgres" }
    var state: RunStatus { RunStatus(rawValue: status) ?? .failed }
    var ready: Bool { status == "ready" || status == "reused" }

    /// Display and TCP copy address only; browser authorization comes from the CLI.
    func localAddress(port: Int) -> String {
        let address = "127.0.0.1:\(port)"
        return isHTTP ? "http://\(address)/" : address
    }
}

struct RemoteRun: Decodable, Identifiable, Sendable {
    let sessionId: String
    let recipientId: String
    let project: String
    let branch: String?
    let worktree: String?
    let primaryApp: String?
    let endpoint: String
    let transport: String
    var connected: Bool { transport == "ready" }
    let expiresAt: Double
    let revision: Int
    let targets: [RemoteTarget]
    var id: String { sessionId }
    var title: String { branch ?? worktree ?? "Main" }
    var primary: RemoteTarget? { targets.first { $0.kind == "app" && $0.name == primaryApp && $0.isHTTP } }
}

struct ConnectionDirectory: Decodable, Sendable {
    let version: Int
    let configured: Bool?
    let origin: String?
    let recipientId: String?
    let generatedAt: Double?
    let runs: [RemoteRun]

    func validate(now: Date = Date()) throws {
        guard version == 1, runs.count <= 100, Set(runs.map(\.id)).count == runs.count else {
            throw ConnectionError("Invalid connection directory; update buncargo")
        }
        if configured == false {
            guard runs.isEmpty else { throw ConnectionError("Invalid unconfigured directory") }
            return
        }
        guard let recipientId, !recipientId.isEmpty, let generatedAt,
            let origin, let directoryURL = URL(string: origin), directoryURL.scheme == "https",
            directoryURL.user == nil, directoryURL.password == nil, directoryURL.query == nil, directoryURL.fragment == nil,
            directoryURL.path.isEmpty || directoryURL.path == "/",
            abs(generatedAt / 1000 - now.timeIntervalSince1970) < 120 else {
            throw ConnectionError("Connection directory is stale")
        }
        for run in runs {
            guard run.recipientId == recipientId, !run.id.isEmpty, run.id.count <= 128,
                run.project.count <= 256, (run.branch?.count ?? 0) <= 256,
                (run.worktree?.count ?? 0) <= 256, run.revision >= 0,
                run.expiresAt / 1000 > now.timeIntervalSince1970,
                run.expiresAt / 1000 <= now.timeIntervalSince1970 + 95,
                !run.targets.isEmpty, run.targets.count <= 64,
                Set(run.targets.map(\.id)).count == run.targets.count,
                run.endpoint.range(of: "^tc[A-Za-z0-9_-]{20,8190}$", options: .regularExpression) != nil,
                ["ready", "connecting"].contains(run.transport) else {
                throw ConnectionError("Invalid shared environment")
            }
            for target in run.targets {
                guard !target.id.isEmpty, target.id.count <= 128,
                    !target.name.isEmpty, target.name.count <= 256,
                    ["app", "service"].contains(target.kind), ["http", "tcp"].contains(target.protocol),
                    ["starting", "ready", "reused", "stopped", "failed"].contains(target.status) else {
                    throw ConnectionError("Invalid shared target")
                }
            }
            if let primary = run.primaryApp, !run.targets.contains(where: { $0.kind == "app" && $0.name == primary }) {
                throw ConnectionError("Invalid shared primary app")
            }
        }
    }
}
struct ConnectionError: LocalizedError, Sendable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
