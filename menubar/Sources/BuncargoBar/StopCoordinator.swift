import AppKit
import Combine
import Foundation

/// Running `buncargo stop`, owned by the app rather than a view.
///
/// The work lives here, not in the menu view. The view is transient by design;
/// anything it owns can be deallocated mid-flight the moment the popover
/// closes. This object is a `@StateObject` on the `App`, so it outlives every
/// popover.
@MainActor
final class StopCoordinator: ObservableObject {
    /// Last failure, shown inline while the popover is open.
    @Published var notice: String?
    /// Targets with a stop already in flight, so a second click while the
    /// first is still running does not spawn a second `buncargo stop`.
    @Published private(set) var inFlight: Set<String> = []

    private unowned let store: RunStore

    init(store: RunStore) {
        self.store = store
    }

    private func key(_ run: Run, _ target: String?) -> String {
        "\(run.id)#\(target ?? "--all")"
    }

    func isStopping(_ run: Run, _ target: String?) -> Bool {
        inFlight.contains(key(run, target))
    }

    /// Stop, no questions asked.
    ///
    /// Always `--force`: the CLI's gates (attached app, an app another terminal
    /// started, a whole run) are there for a terminal prompt, and a click here
    /// already said yes.
    func request(run: Run, target: String?) {
        let token = key(run, target)
        guard !inFlight.contains(token) else { return }
        inFlight.insert(token)
        notice = nil

        Task { [weak self] in
            let outcome = await StopCommand.run(run, target: target, force: true)
            guard let self else { return }
            self.inFlight.remove(token)

            switch outcome {
            case .stopped:
                self.store.reload()
            case .notFound:
                // Already gone: the registry is simply behind.
                self.store.reload()
            case .refused(let message), .failed(let message):
                self.notice = message
                self.report(message)
            }
        }
    }

    /// Boot the checkout's simulator and open its Expo app. Booting takes
    /// seconds, so the button is guarded like a stop is.
    func openSimulator(run: Run, app: String) {
        let token = key(run, "sim:\(app)")
        guard !inFlight.contains(token) else { return }
        inFlight.insert(token)
        notice = nil

        Task { [weak self] in
            let failure = await SimulatorCommand.run(run, app: app)
            guard let self else { return }
            self.inFlight.remove(token)
            if let failure {
                self.notice = failure
                self.report(failure, title: "buncargo sim failed")
            }
        }
    }

    /// A failure has to survive the popover closing, which is where an inline
    /// message goes to die.
    private func report(_ message: String, title: String = "buncargo stop failed") {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}
