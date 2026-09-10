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
    var supportsTablePlus: Bool { ["postgres", "clickhouse"].contains(preset) }
}

struct RemoteRun: Decodable, Identifiable, Sendable {
    let sessionId: String
    let name: String
    let hostname: String
    let project: String
    let branch: String?
    let worktree: String?
    let primaryApp: String?
    let targets: [RemoteTarget]

    var id: String { sessionId }
    var title: String { branch ?? worktree ?? "Main" }
    var primary: RemoteTarget? {
        targets.first { $0.kind == "app" && $0.name == primaryApp && $0.isHTTP }
    }
}

struct TCPConnection: Decodable, Sendable {
    let targetId: String
    let port: Int
    let url: String
    let tablePlusUrl: String?

    // Visitor URLs must point at the local listener returned by this exact action.
    func validate(for target: String) throws {
        guard targetId == target, (1...65535).contains(port), let address = URL(string: url),
            address.host == "127.0.0.1", address.port == port,
            ["tcp", "postgresql", "redis", "clickhouse"].contains(address.scheme)
        else {
            throw ConnectionError("Invalid local connection")
        }
        if let tablePlusUrl {
            guard let address = URL(string: tablePlusUrl), address.host == "127.0.0.1",
                address.port == port,
                ["postgresql", "clickhouse"].contains(address.scheme)
            else { throw ConnectionError("Invalid database connection") }
        }
    }
}

struct ConnectionDirectory: Decodable, Sendable {
    let version: Int
    let configured: Bool
    let generatedAt: Double
    let origin: String
    let notice: String?
    let runs: [RemoteRun]
    let connections: [TCPConnection]?

    func validate(now: Date = Date()) throws {
        guard version == 1, generatedAt.isFinite,
            abs(generatedAt / 1000 - now.timeIntervalSince1970) < 30,
            runs.count <= 100, Set(runs.map(\.id)).count == runs.count,
            configured || runs.isEmpty, let base = URL(string: origin), base.scheme == "https",
            let host = base.host, base.user == nil, base.password == nil
        else { throw ConnectionError("Invalid or stale connection directory") }

        // CLI output is still an input boundary: validate every URL before creating menu actions.
        for run in runs {
            guard !run.id.isEmpty, run.id.count <= 256,
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
                    (1...65535).contains(target.port), target.tablePlusUrl == nil
                else {
                    throw ConnectionError("Invalid remote service")
                }
                if target.isHTTP {
                    guard let url = URL(string: target.url), let targetHost = url.host,
                        targetHost.hasSuffix(".\(host)"),
                        targetHost.dropLast(host.count + 1).range(
                            of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                        url.scheme == "https", url.port == base.port, url.user == nil,
                        url.password == nil,
                        url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/"
                    else {
                        throw ConnectionError("Invalid remote app address")
                    }
                } else if !target.url.isEmpty {
                    throw ConnectionError("TCP services require a local connection")
                }
            }
            if let primary = run.primaryApp,
                !run.targets.contains(where: { $0.kind == "app" && $0.name == primary })
            {
                throw ConnectionError("Invalid primary app")
            }
        }

        for connection in connections ?? [] { try connection.validate(for: connection.targetId) }
    }
}

struct ConnectionError: LocalizedError, Sendable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
