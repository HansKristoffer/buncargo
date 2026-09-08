import AppKit
import Combine
import Foundation

struct ConnectionDependencies {
    var command: @Sendable ([String]) async throws -> Data = { try await ConnectionCommand.run($0) }
    var now: @Sendable () -> Date = { Date() }
}

@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var runs: [RemoteRun] = []
    @Published private(set) var notice: String?
    @Published private(set) var available = false
    @Published private(set) var busy = false
    @Published private(set) var connected: [String: Int] = [:]
    private let deps: ConnectionDependencies
    private var task: Task<Void, Never>?
    private var timer: Timer?
    private var generation = 0
    private var failures = 0
    private var retryAfter = Date.distantPast

    init(deps: ConnectionDependencies = ConnectionDependencies(), startTimer: Bool = true) {
        self.deps = deps
        if startTimer {
            refresh()
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            }
        }
    }
    func refresh(force: Bool = false) {
        runs.removeAll { $0.expiresAt / 1000 <= deps.now().timeIntervalSince1970 }
        if !force && (task != nil || deps.now() < retryAfter) { return }
        generation += 1
        let current = generation
        task?.cancel()
        task = Task {
            defer { if current == generation { task = nil } }
            do {
                let data = try await deps.command(["status"])
                let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: data)
                try directory.validate(now: deps.now())
                guard current == generation, !Task.isCancelled else { return }
                runs = directory.runs.sorted { ($0.project, $0.title, $0.id) < ($1.project, $1.title, $1.id) }
                available = true; notice = nil; failures = 0; retryAfter = .distantPast
                let live = Set(runs.flatMap { run in run.targets.map { "\(run.id):\($0.id)" } })
                connected = connected.filter { live.contains($0.key) }
            } catch {
                guard current == generation, !Task.isCancelled else { return }
                available = false; notice = error.localizedDescription
                connected = [:]
                failures = min(failures + 1, 4)
                retryAfter = deps.now().addingTimeInterval(15 * pow(2, Double(failures - 1)))
            }
        }
    }
    func localPort(_ run: RemoteRun, _ target: RemoteTarget) -> Int? {
        connected["\(run.id):\(target.id)"]
    }

    func waitForRefresh() async { await task?.value }
    func stop() { timer?.invalidate(); generation += 1; task?.cancel(); task = nil }

    func copyToken(rotate: Bool = false, revokeAll: Bool = false) {
        perform {
            let args = rotate ? ["rotate"] + (revokeAll ? ["--all"] : []) : ["token"]
            let data = try await self.deps.command(args)
            struct Result: Decodable { let token: String }
            let result = try JSONDecoder().decode(Result.self, from: data)
            Actions.copy(result.token)
            self.notice = "Connection token copied. Add it to BUNCARGO_CONNECT_TOKENS on the server."
        }
    }
    func connect(_ run: RemoteRun, _ target: RemoteTarget, copy: Bool = false, tablePlus: Bool = false) {
        perform {
            let data = try await self.deps.command(["open", "--session=\(run.id)", "--target=\(target.id)"])
            struct Result: Decodable { let url: String; let port: Int }
            let result = try JSONDecoder().decode(Result.self, from: data)
            guard let url = URL(string: result.url), url.host == "127.0.0.1", url.port == result.port,
                url.user == nil, url.password == nil, (1...65535).contains(result.port),
                url.scheme == (target.protocol == "http" ? "http" : "tcp") else { throw ConnectionError("Invalid local connection") }
            self.connected["\(run.id):\(target.id)"] = result.port
            if target.protocol == "http" {
                if copy { Actions.copy(result.url) } else { Actions.open(result.url) }
            } else if tablePlus && target.preset == "postgres" {
                Actions.open("postgresql://127.0.0.1:\(result.port)?name=\(run.project.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "Remote")")
            } else {
                Actions.copy("127.0.0.1:\(result.port)")
                self.notice = "Connected to \(target.name). Local address copied; use your database credentials."
            }
        }
    }
    func disconnect(_ run: RemoteRun, _ target: RemoteTarget) {
        perform {
            _ = try await self.deps.command(["disconnect", "--session=\(run.id)", "--target=\(target.id)"])
            self.connected.removeValue(forKey: "\(run.id):\(target.id)")
        }
    }
    func revoke(_ run: RemoteRun) {
        perform {
            _ = try await self.deps.command(["revoke", "--session=\(run.id)"])
            self.runs.removeAll { $0.id == run.id }
        }
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; notice = nil
        Task { defer { busy = false }; do { try await action() } catch { notice = error.localizedDescription } }
    }
}
