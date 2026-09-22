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

    /// Revocation is per publishing computer: one sandbox loses access, others keep theirs.
    func revoke(_ run: RemoteRun) {
        Task {
            do {
                _ = try await deps.command(["revoke", run.publisherId])
                notice = "Access removed. That environment can no longer reach this computer."
                refresh(force: true)
            } catch { notice = error.localizedDescription }
        }
    }

    /// Every target already has a local address, so there is nothing to connect first.
    func address(_ target: RemoteTarget) -> String { target.url }

    func perform(_ target: RemoteTarget, action: ConnectionAction = .open) {
        guard canUse(target) else { return }
        switch action {
        case .tablePlus:
            if let tablePlusUrl = target.tablePlusUrl { deps.open(tablePlusUrl) }
        case .copy:
            deps.copy(target.url)
        case .open:
            if target.isHTTP { deps.open(target.url) } else { deps.copy(target.url) }
        }
    }
}
