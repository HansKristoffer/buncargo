import AppKit
import Foundation

/// Everything the menu does to the world outside the app.
enum Actions {
    static func open(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }

    static func copy(_ value: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(value, forType: .string)
    }

    static func revealInFinder(_ path: String) {
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    }

    /// Is TablePlus installed? The button is hidden when it is not, rather than
    /// opening a URL nothing handles.
    static let hasTablePlus: Bool = {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.tinyapp.TablePlus") != nil
    }()

    /// Which URL to actually open for an app or service.
    ///
    /// The named `https://` host only works when the hosts daemon is serving
    /// it. Falling back to loopback here is the same guard the CLI applies
    /// before it prints a named URL: a route is a file until the daemon picks
    /// it up, and opening it earlier lands on a 404 from our own proxy.
    static func preferredURL(named: String?, loopback: String?, hostsActive: Bool) -> String {
        (hostsActive ? named : loopback) ?? ""
    }
}

/// Re-invoking the buncargo that owns a run.
///
/// The app never signals a process, talks to Docker or drives `simctl` itself:
/// it runs the exact buncargo that started the run, recorded in the registry
/// entry, so a worktree on a different version acts with its own build.
enum BuncargoCommand {
    struct Result {
        let status: Int32
        let stderr: String
    }

    static func run(_ run: Run, _ command: [String]) async -> Swift.Result<Result, Error> {
        guard let cli = run.cli else {
            return .failure(CommandError("This run did not record how to invoke buncargo."))
        }

        var arguments: [String] = []
        if let script = cli.script { arguments.append(script) }
        arguments.append(contentsOf: command)
        arguments.append(contentsOf: ["--root", run.root])
        if let sessionId = run.sessionId { arguments.append(contentsOf: ["--run", sessionId]) }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli.program)
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: run.root)
        // Non-interactive: the app has already asked whatever needed asking, and
        // a CLI prompt with no terminal attached would hang the task.
        process.standardInput = FileHandle.nullDevice
        let errorPipe = Pipe()
        process.standardError = errorPipe
        process.standardOutput = Pipe()

        do {
            try process.run()
        } catch {
            return .failure(error)
        }

        let stderr = errorPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let message = String(data: stderr, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return .success(Result(status: process.terminationStatus, stderr: message))
    }

    struct CommandError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}

/// `buncargo stop` for the run that owns a target.
enum StopCommand {
    enum Outcome {
        case stopped
        case notFound
        case refused(String)
        case failed(String)
    }

    static func run(_ run: Run, target: String?, force: Bool) async -> Outcome {
        var command = ["stop", target ?? "--all"]
        if force { command.append("--force") }
        switch await BuncargoCommand.run(run, command) {
        case .failure(let error):
            return .failed(error.localizedDescription)
        case .success(let result):
            switch result.status {
            case 0: return .stopped
            case 2: return .notFound
            case 3: return .refused(result.stderr.isEmpty ? "Refused" : result.stderr)
            default: return .failed(result.stderr.isEmpty ? "buncargo stop failed" : result.stderr)
            }
        }
    }
}

/// `buncargo sim <app>`: boot the checkout's own simulator and open the app in it.
enum SimulatorCommand {
    static func run(_ run: Run, app: String) async -> String? {
        switch await BuncargoCommand.run(run, ["sim", app]) {
        case .failure(let error):
            return error.localizedDescription
        case .success(let result):
            if result.status == 0 { return nil }
            return result.stderr.isEmpty ? "buncargo sim failed" : result.stderr
        }
    }
}
