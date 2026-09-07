import Combine
import Foundation

struct RemoteMachine: Identifiable {
  let endpoint: URL
  var directory: RemoteDirectory?
  var lastSeen: Date?
  var error: String?

  var id: String { directory?.machineId ?? endpoint.absoluteString }
}

struct RemoteDependencies {
  var peers: @Sendable () async throws -> (String?, [TailnetPeer]) = {
    try await TailnetDirectory.peers()
  }

  var fetch: @Sendable (TailnetPeer) async throws -> RemoteDirectory = {
    try await TailnetDirectory.fetch($0)
  }

  var now: @Sendable () -> Date = { Date() }
}

@MainActor
final class RemoteStore: ObservableObject {
  @Published var enabled: Bool {
    didSet {
      preferences.set(enabled, forKey: "tailnetDiscovery")
      invalidateRefresh()

      if enabled {
        refresh(force: true)
      } else {
        machines = []
        notice = nil
      }
    }
  }

  @Published private(set) var machines: [RemoteMachine] = []
  @Published private(set) var notice: String?

  private let preferences: UserDefaults
  private let deps: RemoteDependencies

  // Cancellation can finish late; the generation also invalidates responses already in flight.
  private var task: Task<Void, Never>?
  private var generation = 0
  private var timer: Timer?

  private var failures: [URL: Int] = [:]
  private var retryAfter: [URL: Date] = [:]

  // Remember both endpoint and machine identity so another address cannot re-add a forgotten peer.
  private var forgotten: Set<URL> = []
  private var forgottenMachines: Set<String> = []

  private var manual: [String] { preferences.stringArray(forKey: "tailnetMachines") ?? [] }

  init(
    preferences: UserDefaults = .standard, deps: RemoteDependencies = RemoteDependencies(),
    startTimer: Bool = true
  ) {
    self.preferences = preferences
    self.deps = deps
    enabled = preferences.bool(forKey: "tailnetDiscovery")
    if enabled { refresh() }

    if startTimer {
      timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
        Task { @MainActor in self?.refresh() }
      }
    }
  }

  private func invalidateRefresh() {
    generation += 1
    task?.cancel()
    task = nil
  }

  func add(_ input: String) {
    do {
      let url = try TailnetDirectory.endpoint(input)
      forgotten.remove(url)
      forgottenMachines.removeAll()
      preferences.set(Array(Set(manual + [url.absoluteString])).sorted(), forKey: "tailnetMachines")
      enabled = true
    } catch { notice = error.localizedDescription }
  }

  func remove(_ endpoint: URL) {
    invalidateRefresh()

    if let machine = machines.first(where: { $0.endpoint == endpoint }),
      let id = machine.directory?.machineId
    {
      forgottenMachines.insert(id)
    }

    forgotten.insert(endpoint)
    preferences.set(manual.filter { $0 != endpoint.absoluteString }, forKey: "tailnetMachines")
    machines.removeAll { $0.endpoint == endpoint }
  }

  /// Menu opening respects backoff; the explicit Refresh button can override it.
  func refresh(force: Bool = false) {
    guard enabled else { return }

    if task != nil {
      guard force else { return }
      invalidateRefresh()
    }

    let current = generation
    task = Task {
      defer { if current == generation { task = nil } }

      var candidates = manual.compactMap { value -> TailnetPeer? in
        guard let url = try? TailnetDirectory.endpoint(value) else { return nil }
        return TailnetPeer(id: nil, endpoint: url)
      }
      candidates += machines.map { TailnetPeer(id: $0.directory?.machineId, endpoint: $0.endpoint) }

      // Known/manual endpoints begin loading immediately, even if CLI discovery stalls.
      let attemptedKnown = Set(candidates.map(\.endpoint))
      await probe(candidates, selfID: nil, generation: current, force: force)
      guard current == generation, enabled, !Task.isCancelled else { return }

      var selfID: String?
      do {
        let discovered = try await deps.peers()
        guard current == generation, enabled, !Task.isCancelled else { return }
        selfID = discovered.0
        candidates = discovered.1
        notice = nil
      } catch {
        guard current == generation, enabled, !Task.isCancelled else { return }
        notice = error.localizedDescription
        candidates = []
      }
      guard current == generation, enabled, !Task.isCancelled else { return }
      if let selfID { machines.removeAll { $0.directory?.machineId == selfID } }

      // Even failed known probes should only be attempted once per refresh.
      await probe(
        candidates.filter { !attemptedKnown.contains($0.endpoint) }, selfID: selfID,
        generation: current, force: force)
      guard current == generation else { return }
      machines.sort { $0.endpoint.absoluteString < $1.endpoint.absoluteString }
    }
  }

  private func probe(
    _ candidates: [TailnetPeer], selfID: String?, generation current: Int, force: Bool
  ) async {
    var seen: Set<URL> = []
    let candidates = candidates.filter {
      seen.insert($0.endpoint).inserted && !forgotten.contains($0.endpoint)
        && (force || (retryAfter[$0.endpoint] ?? .distantPast) <= deps.now())
    }

    for start in stride(from: 0, to: candidates.count, by: 4) {
      guard current == generation, enabled, !Task.isCancelled else { return }

      let batch = Array(candidates[start..<min(start + 4, candidates.count)])
      let fetch = deps.fetch

      await withTaskGroup(of: (TailnetPeer, RemoteDirectory?, String?).self) { group in
        for peer in batch {
          group.addTask {
            do { return (peer, try await fetch(peer), nil) } catch {
              return (peer, nil, error.localizedDescription)
            }
          }
        }

        // Publish each response promptly, without waiting for its slowest batch peer.
        for await (peer, directory, error) in group {
          guard current == generation, enabled, !Task.isCancelled else {
            group.cancelAll()
            return
          }

          if let id = directory?.machineId, id == selfID || forgottenMachines.contains(id) {
            continue
          }

          if directory != nil {
            failures.removeValue(forKey: peer.endpoint)
            retryAfter.removeValue(forKey: peer.endpoint)
          } else {
            let count = min((failures[peer.endpoint] ?? 0) + 1, 4)
            failures[peer.endpoint] = count
            retryAfter[peer.endpoint] = deps.now().addingTimeInterval(
              30 * pow(2, Double(count - 1)))
          }

          if let directory,
            let duplicate = machines.firstIndex(where: {
              $0.directory?.machineId == directory.machineId && $0.endpoint != peer.endpoint
            })
          {
            // Prefer a reachable endpoint for the same machine; retain one machine row.
            if machines[duplicate].error != nil {
              machines[duplicate] = RemoteMachine(
                endpoint: peer.endpoint, directory: directory, lastSeen: deps.now())
            }
            continue
          }

          // Keep the last successful snapshot visible on failure and label it with the new error.
          if let index = machines.firstIndex(where: { $0.endpoint == peer.endpoint }) {
            if let directory {
              machines[index].directory = directory
              machines[index].lastSeen = deps.now()
            }
            machines[index].error = error
          } else if directory != nil || manual.contains(peer.endpoint.absoluteString) {
            machines.append(
              RemoteMachine(
                endpoint: peer.endpoint, directory: directory,
                lastSeen: directory == nil ? nil : deps.now(), error: error))
          }
        }
      }
    }
  }

  /// Test/explicit callers can await the current refresh without polling UI state.
  func waitForRefresh() async { await task?.value }
}
