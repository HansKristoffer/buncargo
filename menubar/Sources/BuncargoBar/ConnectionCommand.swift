import Foundation

/// Local credentials stay with the CLI. Remote metadata never selects an executable.
enum ConnectionCommand {
    private struct Device: Decodable { let cli: RunCLI }

    static func run(_ arguments: [String]) async throws -> Data {
        try await Task.detached(priority: .utility) {
            let deviceURL = RunRegistry.stateDirectory.appendingPathComponent("connect-device.json")
            let saved = (try? Data(contentsOf: deviceURL)).flatMap { try? JSONDecoder().decode(Device.self, from: $0) }
            let candidates = [saved?.cli].compactMap { $0 } + ((try? RunRegistry.load())?.compactMap(\.cli) ?? [])
            let cli = candidates.first { candidate in
                FileManager.default.isExecutableFile(atPath: candidate.program) && (candidate.script.map { FileManager.default.fileExists(atPath: $0) } ?? true)
            }
            let process = Process()
            if let cli {
                process.executableURL = URL(fileURLWithPath: cli.program)
                process.arguments = (cli.script.map { [$0] } ?? []) + ["connect"] + arguments + ["--json"]
            } else {
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                process.arguments = ["buncargo", "connect"] + arguments + ["--json"]
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
                throw ConnectionError("Connection command failed. Run buncargo connect status in a terminal; update the CLI if connect is unavailable.")
            }
            let size = (try FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0
            guard size <= 131072 else { throw ConnectionError("Connection response too large") }
            return try Data(contentsOf: output)
        }.value
    }
}
