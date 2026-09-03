import AppKit
import Combine
import Foundation

/// Confirming and running `buncargo stop`, owned by the app rather than a view.
///
/// Both halves of that matter, and both were bugs:
///
/// 1. **Confirmation is an `NSAlert`, not SwiftUI's `.alert`.** A
///    `MenuBarExtra(.window)` popover dismisses as soon as it resigns key, and
///    presenting a SwiftUI alert does exactly that — the popover closes, the
///    view holding the alert's `@State` is torn down, and the button's action
///    closure never runs. The alert appeared and "Stop" did nothing.
/// 2. **The work lives here, not in the menu view.** The view is transient by
///    design; anything it owns can be deallocated mid-flight the moment the
///    popover closes. This object is a `@StateObject` on the `App`, so it
///    outlives every popover.
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
        "\(run.root)#\(target ?? "--all")"
    }

    func isStopping(_ run: Run, _ target: String?) -> Bool {
        inFlight.contains(key(run, target))
    }

    /// Confirm when it is risky, then stop.
    ///
    /// Only two cases ask, matching what the CLI itself refuses without
    /// `--force`: the attached app, because closing it stops the whole run, and
    /// an app this run reused from another terminal, because that process
    /// belongs to someone else. A plain SIGTERM of a dev server is what Ctrl-C
    /// does all day and needs no dialog.
    func request(run: Run, target: String?) {
        guard let question = confirmation(run: run, target: target) else {
            perform(run: run, target: target, force: false)
            return
        }
        guard confirm(question) else { return }
        perform(run: run, target: target, force: true)
    }

    private func confirmation(run: Run, target: String?) -> String? {
        guard let target else {
            return "Stop \(run.projectName)?\n\nThis stops dev servers running in another terminal."
        }
        guard let app = run.apps.first(where: { $0.name == target }) else {
            return nil
        }
        if app.attached == true {
            return "Stop \(app.name)?\n\nIt holds the terminal, so this stops the whole run."
        }
        if !app.isOwned {
            return "Stop \(app.name)?\n\nIt was started by another terminal, so this stops a process this run does not own."
        }
        return nil
    }

    private func confirm(_ message: String) -> Bool {
        let parts = message.split(separator: "\n\n", maxSplits: 1)
        let alert = NSAlert()
        alert.messageText = String(parts.first ?? "")
        alert.informativeText = parts.count > 1 ? String(parts[1]) : ""
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Stop")
        alert.addButton(withTitle: "Cancel")

        // An accessory app has no menu bar of its own, so its modal opens
        // behind whatever is frontmost unless it activates first.
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func perform(run: Run, target: String?, force: Bool) {
        let token = key(run, target)
        guard !inFlight.contains(token) else { return }
        inFlight.insert(token)
        notice = nil

        Task { [weak self] in
            let outcome = await StopCommand.run(run, target: target, force: force)
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

    /// A failure has to survive the popover closing, which is where an inline
    /// message goes to die.
    private func report(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "buncargo stop failed"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}
