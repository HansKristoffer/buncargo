import Combine
import Foundation

struct RemoteMachine: Identifiable {
    let endpoint: URL
    var directory: RemoteDirectory?
    var lastSeen: Date?
    var error: String?

    var id: String { endpoint.absoluteString }
}

@MainActor
final class RemoteStore: ObservableObject {
    @Published var enabled: Bool {
        didSet {
            UserDefaults.standard.set(enabled, forKey: "tailnetDiscovery")
            if enabled {
                refresh()
            } else {
                machines = []
                notice = nil
            }
        }
    }

    @Published private(set) var machines: [RemoteMachine] = []
    @Published private(set) var notice: String?

    private var refreshing = false
    private var timer: Timer?
    private var failures: [URL: Int] = [:]
    private var retryAfter: [URL: Date] = [:]

    private var manual: [String] {
        UserDefaults.standard.stringArray(forKey: "tailnetMachines") ?? []
    }

    init() {
        enabled = UserDefaults.standard.bool(forKey: "tailnetDiscovery")
        if enabled {
            refresh()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh(force: false) }
        }
    }

    func add(_ input: String) {
        do {
            let endpoint = try TailnetDirectory.endpoint(input).absoluteString
            UserDefaults.standard.set(
                Array(Set(manual + [endpoint])).sorted(), forKey: "tailnetMachines")
            enabled = true
        } catch {
            notice = error.localizedDescription
        }
    }

    func remove(_ endpoint: URL) {
        UserDefaults.standard.set(
            manual.filter { $0 != endpoint.absoluteString }, forKey: "tailnetMachines")
        machines.removeAll { $0.endpoint == endpoint }
    }

    func refresh(force: Bool = true) {
        guard enabled, !refreshing else {
            return
        }

        refreshing = true

        Task {
            defer {
                refreshing = false
            }

            var candidates: [TailnetPeer] = []
            var selfID: String?

            do {
                (selfID, candidates) = try await TailnetDirectory.peers()
                notice = nil
            } catch {
                notice = error.localizedDescription
            }

            candidates += manual.compactMap { value in
                guard let url = try? TailnetDirectory.endpoint(value) else {
                    return nil
                }
                return TailnetPeer(id: nil, endpoint: url)
            }

            // Retain known devices so sleeping/disconnected peers become offline,
            // rather than vanishing and implying that their runs stopped.

            candidates += machines.map {
                TailnetPeer(id: $0.directory?.machineId, endpoint: $0.endpoint)
            }

            var seen: Set<URL> = []
            candidates = candidates.filter { seen.insert($0.endpoint).inserted }
            if !force {
                candidates = candidates.filter {
                    (retryAfter[$0.endpoint] ?? .distantPast) <= Date()
                }
            }

            // Four requests at a time; a large tailnet must not flood the client.
            for start in stride(from: 0, to: candidates.count, by: 4) {

                guard enabled else {
                    return
                }

                let batch = Array(candidates[start..<min(start + 4, candidates.count)])
                let results = await withTaskGroup(of: (TailnetPeer, RemoteDirectory?, String?).self)
                { group in
                    for peer in batch {
                        group.addTask {

                            do {
                                return (peer, try await TailnetDirectory.fetch(peer), nil)
                            } catch {
                                return (peer, nil, error.localizedDescription)
                            }
                        }
                    }

                    var results: [(TailnetPeer, RemoteDirectory?, String?)] = []
                    for await result in group {
                        results.append(result)
                    }

                    return results
                }

                guard enabled else {
                    return
                }

                for (peer, directory, error) in results {
                    if directory?.machineId == selfID, directory != nil {
                        continue
                    }

                    if directory != nil {
                        failures.removeValue(forKey: peer.endpoint)
                        retryAfter.removeValue(forKey: peer.endpoint)
                    } else {
                        let count = min((failures[peer.endpoint] ?? 0) + 1, 4)
                        failures[peer.endpoint] = count
                        retryAfter[peer.endpoint] = Date().addingTimeInterval(
                            30 * pow(2, Double(count - 1)))
                    }

                    if let index = machines.firstIndex(where: {
                        $0.endpoint == peer.endpoint
                    }) {
                        if let directory {
                            machines[index].directory = directory
                            machines[index].lastSeen = Date()
                        }
                        machines[index].error = error
                    } else if directory != nil || manual.contains(peer.endpoint.absoluteString) {
                        machines.append(
                            RemoteMachine(
                                endpoint: peer.endpoint, directory: directory,
                                lastSeen: directory == nil ? nil : Date(), error: error))
                    }
                }
            }

            machines.sort { $0.endpoint.absoluteString < $1.endpoint.absoluteString }
        }
    }
}
