import Combine
import Foundation

struct ConnectionDependencies {
    var command: @Sendable ([String]) async throws -> Data = { try await ConnectionCommand.run($0) }
    var now: @Sendable () -> Date = { Date() }
    var open: @MainActor (String) -> Void = { Actions.open($0) }
    var copy: @MainActor (String) -> Void = { Actions.copy($0) }
}
enum ConnectionAction { case open, copy, tablePlus }

/// Tailscale owns connections and access. The menu only discovers metadata and opens validated URLs.
@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var runs: [RemoteRun] = []
    @Published private(set) var notice: String?
    @Published private(set) var available = false
    private let deps: ConnectionDependencies
    private var task: Task<Void, Never>?
    private var timer: Timer?
    private var generation = 0

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
        if task != nil && !force { return }
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
                runs = directory.runs.sorted { ($0.project, $0.title, $0.hostname, $0.id) < ($1.project, $1.title, $1.hostname, $1.id) }
                available = directory.configured
                notice = directory.notice
            } catch {
                guard current == generation, !Task.isCancelled else { return }
                runs = []
                available = false
                notice = error.localizedDescription
            }
        }
    }
    func status(_ run: RemoteRun, target: RemoteTarget? = nil) -> RunStatus {
        available ? (target?.state ?? .rollup(run.targets.map(\.state))) : .failed
    }
    func canUse(_ target: RemoteTarget) -> Bool { available && target.ready }
    func waitForRefresh() async { await task?.value }
    func stop() { timer?.invalidate(); generation += 1; task?.cancel(); task = nil }

    func perform(_ run: RemoteRun, _ target: RemoteTarget, action: ConnectionAction = .open) {
        guard canUse(target) else { return }
        if action == .tablePlus && target.isPostgres {
            var url = URLComponents()
            url.scheme = "postgresql"
            url.host = run.hostname
            url.port = target.port
            url.queryItems = [URLQueryItem(name: "name", value: "\(run.project) · \(run.title)")]
            if let address = url.string { deps.open(address) }
        } else if action == .copy || !target.isHTTP {
            deps.copy(target.address(hostname: run.hostname))
        } else { deps.open(target.url) }
    }
}
