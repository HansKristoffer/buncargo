import Combine
import Foundation

struct ConnectionDependencies {
    var command: @Sendable ([String]) async throws -> Data = { try await ConnectionCommand.run($0) }
    var now: @Sendable () -> Date = { Date() }
    var open: @MainActor (String) -> Void = { Actions.open($0) }
    var copy: @MainActor (String) -> Void = { Actions.copy($0) }
}

enum ConnectionAction { case open, copy, tablePlus }

/// Network lifecycle belongs to the CLI; the bar renders state and requests actions.
@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var runs: [RemoteRun] = []
    @Published private(set) var notice: String?
    @Published private(set) var available = false
    @Published private(set) var connections: [String: TCPConnection] = [:]
    @Published private(set) var connecting: Set<String> = []
    private let deps: ConnectionDependencies
    private var task: Task<Void, Never>?
    private var timer: Timer?
    private var generation = 0

    init(deps: ConnectionDependencies = ConnectionDependencies(), startTimer: Bool = true) {
        self.deps = deps
        if startTimer {
            refresh()
            timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            }
        }
    }

    func refresh(force: Bool = false) {
        if task != nil && !force { return }

        generation += 1
        let current = generation
        task?.cancel()

        // Cancellation alone cannot stop an already-running CLI command. Ignore older results.
        task = Task {
            defer { if current == generation { task = nil } }
            do {
                let data = try await deps.command(["status"])
                let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: data)
                try directory.validate(now: deps.now())
                guard current == generation, !Task.isCancelled else { return }

                runs = directory.runs.sorted {
                    ($0.name, $0.project, $0.title, $0.id) < ($1.name, $1.project, $1.title, $1.id)
                }
                connections = Dictionary(
                    (directory.connections ?? []).map { ($0.targetId, $0) },
                    uniquingKeysWith: { first, _ in first })
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

    func stop() {
        timer?.invalidate()
        generation += 1
        task?.cancel()
        task = nil
    }

    func copyToken(rotate: Bool = false) {
        Task {
            do {
                struct Token: Decodable { let token: String }
                let data = try await deps.command(["token"] + (rotate ? ["--rotate"] : []))
                let token = try JSONDecoder().decode(Token.self, from: data)
                deps.copy(token.token)
                refresh(force: true)
            } catch { notice = error.localizedDescription }
        }
    }

    func revoke(_ run: RemoteRun) {
        Task {
            do {
                _ = try await deps.command(["revoke", run.id])
                notice = "Access removal requested; existing connections close within 45 seconds."
                refresh(force: true)
            } catch { notice = error.localizedDescription }
        }
    }

    func disconnect(_ target: RemoteTarget) {
        Task {
            do {
                _ = try await deps.command(["disconnect", target.id])
                connections.removeValue(forKey: target.id)
            } catch { notice = error.localizedDescription }
        }
    }

    func address(_ target: RemoteTarget) -> String {
        if target.isHTTP { return target.url }
        if connecting.contains(target.id) { return "Connecting…" }
        return connections[target.id]?.url ?? "Private TCP"
    }

    func perform(_ target: RemoteTarget, action: ConnectionAction = .open) {
        guard canUse(target), !connecting.contains(target.id) else { return }
        if target.isHTTP {
            if action == .copy { deps.copy(target.url) } else { deps.open(target.url) }
            return
        }

        // Database actions use the actual bound visitor port returned by the CLI.
        connecting.insert(target.id)
        Task {
            defer { connecting.remove(target.id) }
            do {
                let data = try await deps.command(["tcp", target.id])
                let connection = try JSONDecoder().decode(TCPConnection.self, from: data)
                try connection.validate(for: target.id)
                connections[target.id] = connection
                if action == .tablePlus, let url = connection.tablePlusUrl {
                    deps.open(url)
                } else {
                    deps.copy(connection.url)
                }
            } catch { notice = error.localizedDescription }
        }
    }
}
