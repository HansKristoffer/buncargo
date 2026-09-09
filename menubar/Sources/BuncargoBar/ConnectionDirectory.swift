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
    /// Database deeplink with credentials, published only to authenticated tailnet peers.
    let tablePlusUrl: String?
    var isHTTP: Bool { `protocol` == "http" }
    var state: RunStatus { RunStatus(rawValue: status) ?? .failed }
    var ready: Bool { status == "ready" || status == "reused" }
    func address(hostname: String) -> String { isHTTP ? url : "\(hostname):\(port)" }
}

struct RemoteRun: Decodable, Identifiable, Sendable {
    let sessionId: String
    let machineId: String
    let hostname: String
    let project: String
    let branch: String?
    let worktree: String?
    let primaryApp: String?
    let targets: [RemoteTarget]
    var id: String { sessionId }
    var title: String { branch ?? worktree ?? "Main" }
    var primary: RemoteTarget? { targets.first { $0.kind == "app" && $0.name == primaryApp && $0.isHTTP } }
}

struct ConnectionDirectory: Decodable, Sendable {
    let version: Int
    let configured: Bool
    let generatedAt: Double
    let notice: String?
    let runs: [RemoteRun]

    func validate(now: Date = Date()) throws {
        guard version == 1, generatedAt.isFinite, abs(generatedAt / 1000 - now.timeIntervalSince1970) < 30,
              runs.count <= 100, Set(runs.map(\.id)).count == runs.count,
              configured || runs.isEmpty else { throw ConnectionError("Invalid or stale Tailscale directory") }
        for run in runs {
            guard !run.id.isEmpty, run.id.count <= 256, !run.machineId.isEmpty,
                  !run.project.isEmpty, run.project.count <= 256, (run.branch?.count ?? 0) <= 256,
                  (run.worktree?.count ?? 0) <= 256,
                  run.hostname.range(of: "^[a-z0-9-]+\\.[a-z0-9-]+\\.ts\\.net$", options: .regularExpression) != nil,
                  run.targets.count <= 64, Set(run.targets.map(\.id)).count == run.targets.count else {
                throw ConnectionError("Invalid remote environment")
            }
            for target in run.targets {
                guard !target.id.isEmpty, target.id.count <= 256, !target.name.isEmpty, target.name.count <= 256,
                      ["app", "service"].contains(target.kind), ["http", "tcp"].contains(target.protocol),
                      ["starting", "ready", "reused", "stopped", "failed"].contains(target.status),
                      (20000...29999).contains(target.port),
                      let url = URL(string: target.url), url.host == run.hostname, url.port == target.port,
                      url.scheme == (target.isHTTP ? "https" : "tcp"), url.user == nil, url.password == nil,
                      url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else {
                    throw ConnectionError("Invalid remote service address")
                }
                if let deeplink = target.tablePlusUrl {
                    guard !target.isHTTP, deeplink.count <= 2048, let url = URL(string: deeplink),
                          url.host == run.hostname, url.port == target.port,
                          ["postgresql", "clickhouse"].contains(url.scheme) else {
                        throw ConnectionError("Invalid remote service address")
                    }
                }
            }
            if let primary = run.primaryApp, !run.targets.contains(where: { $0.kind == "app" && $0.name == primary }) {
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
