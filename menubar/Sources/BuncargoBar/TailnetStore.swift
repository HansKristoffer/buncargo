import Combine
import Foundation

/// An online machine on this Mac's tailnet, as `tailscale status` reports it.
struct TailnetPeer: Sendable, Hashable {
    let name: String
    let address: String
}

/// A peer that answered with runs.
struct TailnetMachine: Identifiable {
    let peer: TailnetPeer
    let runs: [Run]

    var id: String { peer.address }
}

struct TailnetError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Every machine's watchdog serves its live runs on its Tailscale address
/// (`src/core/tailnet-directory.ts`); the bar finds the machines and asks.
enum Tailnet {
    static let directoryPort = 48480

    private struct Status: Decodable {
        struct Device: Decodable {
            let HostName: String
            let DNSName: String?
            let TailscaleIPs: [String]?
            let Online: Bool?
        }
        let BackendState: String
        let Peer: [String: Device]?
    }

    /// Online peers, from the local Tailscale CLI. No CLI or a stopped
    /// Tailscale is an empty tailnet, not an error worth a line in the menu.
    static func peers() async throws -> [TailnetPeer] {
        try await Task.detached(priority: .utility) {
            let paths = [
                "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale",
            ]
            guard let binary = paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
            else { return [] }

            let process = Process()
            var environment = ProcessInfo.processInfo.environment
            // The app bundle's binary is the GUI unless told to act as the CLI.
            environment["TAILSCALE_BE_CLI"] = "1"
            process.environment = environment
            process.executableURL = URL(fileURLWithPath: binary)
            process.arguments = ["status", "--json"]
            process.standardInput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            let pipe = Pipe()
            process.standardOutput = pipe
            try process.run()
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: timeout)
            defer { timeout.cancel() }

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return [] }
            return try parsePeers(data)
        }.value
    }

    static func parsePeers(_ data: Data) throws -> [TailnetPeer] {
        let status = try JSONDecoder().decode(Status.self, from: data)
        guard status.BackendState == "Running" else { return [] }
        return (status.Peer ?? [:]).values.compactMap { device in
            guard device.Online == true,
                let address = device.TailscaleIPs?.first(where: { !$0.contains(":") })
            else { return nil }
            // The machine name as the tailnet shows it; the OS hostname otherwise.
            let name = device.DNSName?.split(separator: ".").first.map(String.init)
            return TailnetPeer(name: name ?? device.HostName, address: address)
        }
    }

    static func fetch(_ peer: TailnetPeer) async throws -> [Run] {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 5
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }

        guard let url = URL(string: "http://\(peer.address):\(directoryPort)/v1/runs") else { return [] }
        let (data, response) = try await session.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 4 * 1_048_576 else {
            throw TailnetError(message: "No directory on \(peer.name)")
        }
        let file = try JSONDecoder().decode(RunsFile.self, from: data)
        guard file.version == RunRegistry.supportedVersion else {
            throw UnsupportedRegistryVersion(found: file.version, supported: RunRegistry.supportedVersion)
        }
        return file.runs
    }

    /// An address another machine can open.
    ///
    /// The named URL when it already points somewhere else (`BUNCARGO_URL_HOST`,
    /// a public URL); otherwise the loopback URL on the peer's Tailscale IP.
    /// The IP rather than its MagicDNS name, because Vite accepts any IP but
    /// rejects a hostname it was not told about.
    static func reachableURL(named: String?, loopback: String?, at address: String) -> String? {
        if let named, let host = URLComponents(string: named)?.host, !isLocal(host) {
            return named
        }
        guard var components = loopback.flatMap(URLComponents.init(string:)) else { return nil }
        if let host = components.host, isLocal(host) { components.host = address }
        return components.string
    }

    private static func isLocal(_ host: String) -> Bool {
        host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".localhost")
    }
}

struct TailnetDependencies {
    var peers: @Sendable () async throws -> [TailnetPeer] = { try await Tailnet.peers() }
    var fetch: @Sendable (TailnetPeer) async throws -> [Run] = { try await Tailnet.fetch($0) }
    var now: @Sendable () -> Date = { Date() }
}

/// Runs on the other machines of this Mac's tailnet.
@MainActor
final class TailnetStore: ObservableObject {
    @Published private(set) var machines: [TailnetMachine] = []
    private let deps: TailnetDependencies
    private var task: Task<Void, Never>?
    private var timer: Timer?
    /// Most peers (phones, machines without buncargo) never answer; ask them
    /// less often rather than every refresh.
    private var retryAfter: [String: Date] = [:]

    init(deps: TailnetDependencies = TailnetDependencies(), startTimer: Bool = true) {
        self.deps = deps
        if startTimer {
            refresh()
            timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        task?.cancel()
    }

    func refresh(force: Bool = false) {
        if force { retryAfter = [:] }
        if task != nil { return }

        task = Task {
            defer { task = nil }
            let peers = ((try? await deps.peers()) ?? []).filter {
                (retryAfter[$0.address] ?? .distantPast) <= deps.now()
            }

            let fetch = deps.fetch
            var answered: [TailnetMachine] = []
            await withTaskGroup(of: (TailnetPeer, [Run]?).self) { group in
                for peer in peers {
                    group.addTask { (peer, try? await fetch(peer)) }
                }
                for await (peer, runs) in group {
                    if let runs {
                        retryAfter[peer.address] = nil
                        if !runs.isEmpty { answered.append(TailnetMachine(peer: peer, runs: runs)) }
                    } else {
                        retryAfter[peer.address] = deps.now().addingTimeInterval(120)
                    }
                }
            }
            guard !Task.isCancelled else { return }
            machines = answered.sorted { $0.peer.name < $1.peer.name }
        }
    }

    func waitForRefresh() async { await task?.value }
}
