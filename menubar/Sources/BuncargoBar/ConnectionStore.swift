import Combine
import Foundation

struct ConnectionDependencies {
    var command: @Sendable ([String]) async throws -> Data = { try await ConnectionCommand.run($0) }
    var now: @Sendable () -> Date = { Date() }
    var open: @MainActor (String) -> Void = { Actions.open($0) }
    var copy: @MainActor (String) -> Void = { Actions.copy($0) }
}

enum ConnectionAction {
    case open, copy, tablePlus
}

@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var runs: [RemoteRun] = []
    @Published private(set) var notice: String?
    @Published private(set) var available = false
    @Published private(set) var busy = false
    @Published private var connected: [String: Int] = [:]

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
                available = true
                notice = nil
                failures = 0
                retryAfter = .distantPast
                let live = Set(runs.flatMap { run in
                    run.targets.map { connectionKey(run, $0) }
                })
                connected = connected.filter { live.contains($0.key) }
            } catch {
                guard current == generation, !Task.isCancelled else { return }
                available = false
                notice = error.localizedDescription
                connected = [:]
                failures = min(failures + 1, 4)
                retryAfter = deps.now().addingTimeInterval(15 * pow(2, Double(failures - 1)))
            }
        }
    }

    func status(_ run: RemoteRun, target: RemoteTarget? = nil) -> RunStatus {
        if !available { return .failed }
        if !run.connected { return .starting }
        return target?.state ?? .rollup(run.targets.map(\.state))
    }

    func canConnect(_ run: RemoteRun, _ target: RemoteTarget) -> Bool {
        available && run.connected && target.ready && !busy
    }

    func localPort(_ run: RemoteRun, _ target: RemoteTarget) -> Int? {
        connected[connectionKey(run, target)]
    }

    func waitForRefresh() async { await task?.value }

    func stop() {
        timer?.invalidate()
        generation += 1
        task?.cancel()
        task = nil
    }

    func copyToken(rotate: Bool = false, revokeAll: Bool = false) {
        perform {
            let args = rotate ? ["rotate"] + (revokeAll ? ["--all"] : []) : ["token"]
            let data = try await self.deps.command(args)
            struct Result: Decodable { let token: String }
            let result = try JSONDecoder().decode(Result.self, from: data)
            self.deps.copy(result.token)
            self.notice = "Connection token copied. Add it to BUNCARGO_CONNECT_TOKENS on the server."
        }
    }

    func connect(_ run: RemoteRun, _ target: RemoteTarget, action: ConnectionAction = .open) {
        perform {
            let data = try await self.deps.command(["open", "--session=\(run.id)", "--target=\(target.id)"])
            struct Result: Decodable {
                let url: String
                let port: Int
            }
            let result = try JSONDecoder().decode(Result.self, from: data)
            guard let url = URL(string: result.url),
                url.host == "127.0.0.1", url.port == result.port,
                url.user == nil, url.password == nil,
                (1...65535).contains(result.port),
                url.scheme == (target.isHTTP ? "http" : "tcp")
            else { throw ConnectionError("Invalid local connection") }

            self.connected[self.connectionKey(run, target)] = result.port
            if target.isHTTP {
                // Keep the CLI's authorization URL intact; the row displays only the address.
                if action == .copy {
                    self.deps.copy(result.url)
                } else {
                    self.deps.open(result.url)
                }
            } else if action == .tablePlus && target.isPostgres {
                var url = URLComponents()
                url.scheme = "postgresql"
                url.host = "127.0.0.1"
                url.port = result.port
                url.queryItems = [URLQueryItem(name: "name", value: run.project)]
                guard let address = url.string else { throw ConnectionError("Invalid local connection") }
                self.deps.open(address)
            } else {
                self.deps.copy(target.localAddress(port: result.port))
                self.notice = "Connected to \(target.name). Local address copied; use your database credentials."
            }
        }
    }

    func disconnect(_ run: RemoteRun, _ target: RemoteTarget) {
        perform {
            _ = try await self.deps.command(["disconnect", "--session=\(run.id)", "--target=\(target.id)"])
            self.connected.removeValue(forKey: self.connectionKey(run, target))
        }
    }

    func revoke(_ run: RemoteRun) {
        perform {
            _ = try await self.deps.command(["revoke", "--session=\(run.id)"])
            self.runs.removeAll { $0.id == run.id }
        }
    }

    private func connectionKey(_ run: RemoteRun, _ target: RemoteTarget) -> String {
        "\(run.id):\(target.id)"
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        notice = nil
        Task {
            defer { busy = false }
            do {
                try await action()
            } catch {
                notice = error.localizedDescription
            }
        }
    }
}
