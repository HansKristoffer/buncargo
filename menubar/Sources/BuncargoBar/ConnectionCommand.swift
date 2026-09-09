import Foundation

/// Discovery invokes only a locally installed CLI. Remote metadata never selects an executable.
enum ConnectionCommand {
    private struct CommandManifest: Decodable { let cli: RunCLI }

    static func run(_ arguments: [String]) async throws -> Data {
        try await Task.detached(priority: .utility) {
            let saved = ["bar.json", "tailnet-coordinator.json"].compactMap { name -> RunCLI? in
                let file = RunRegistry.stateDirectory.appendingPathComponent(name)
                return (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(CommandManifest.self, from: $0) }?.cli
            }
            let candidates = saved + ((try? RunRegistry.load())?.compactMap(\.cli) ?? [])
            let cli = candidates.first { candidate in
                FileManager.default.isExecutableFile(atPath: candidate.program) && (candidate.script.map { FileManager.default.fileExists(atPath: $0) } ?? true)
            }
            let process = Process()
            if let cli {
                process.executableURL = URL(fileURLWithPath: cli.program)
                process.arguments = (cli.script.map { [$0] } ?? []) + ["tailnet"] + arguments + ["--json"]
            } else {
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = ["buncargo", "tailnet"] + arguments + ["--json"]
                var env = ProcessInfo.processInfo.environment
                let home = RunRegistry.stateDirectory.deletingLastPathComponent().path
                env["PATH"] = "\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
                process.environment = env
            }
            process.standardInput = FileHandle.nullDevice
            // Files avoid pipe deadlock and prevent command output from blocking the main actor.
            let output = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            guard FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw ConnectionError("Could not create command output file")
            }
            defer { try? FileManager.default.removeItem(at: output) }
            let handle = try FileHandle(forWritingTo: output)
            defer { try? handle.close() }
            process.standardOutput = handle
            process.standardError = FileHandle.nullDevice
            try process.run()
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timeout)
            defer { timeout.cancel() }
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                throw ConnectionError("Tailscale discovery failed. Run buncargo tailnet status in a terminal.")
            }
            let size = (try FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0
            guard size <= 1048576 else { throw ConnectionError("Connection response too large") }
            return try Data(contentsOf: output)
        }.value
    }
}
