import AppKit
import SwiftUI

@main
enum BuncargoBarMain {
    static func main() {
        // `--status` is the troubleshooting path: it answers "can the app see
        // my runs?" without the UI, which is the first question when the menu
        // looks empty and `buncargo runs` does not.
        if CommandLine.arguments.contains("--status") {
            printStatus()
            return
        }
        if CommandLine.arguments.contains("--selftest") {
            selfTest()
            return
        }
        BuncargoBarApp.main()
    }

    /// Checks the notification diff against the registry it will see in
    /// production. Runs in CI, where the fixture is the whole world.
    static func selfTest() {
        let runs = (try? RunRegistry.load()) ?? []
        let startedRuns = runs.filter { $0.primary?.state.isUp == true }
        var announced: Set<String> = []

        var failures: [String] = []
        let first = Notifier.newlyStarted(runs: runs, announced: &announced)
        if first.count != startedRuns.count {
            failures.append("first pass announced \(first.count), expected \(startedRuns.count)")
        }
        if !Notifier.newlyStarted(runs: runs, announced: &announced).isEmpty {
            failures.append("second pass announced the same runs again")
        }
        // A run that goes away and comes back is news again.
        if Notifier.newlyStarted(runs: [], announced: &announced).isEmpty,
            Notifier.newlyStarted(runs: runs, announced: &announced).count != startedRuns.count
        {
            failures.append("a restarted run did not announce")
        }

        // Sessions can start in the same checkout at the same timestamp.
        // Each session announces once, independently of the other session.
        if var firstSession = startedRuns.first {
            var secondSession = firstSession
            firstSession.sessionId = "notification-session-1"
            secondSession.sessionId = "notification-session-2"
            let sessions = [firstSession, secondSession]
            var sessionAnnouncements: Set<String> = []
            if Notifier.newlyStarted(runs: sessions, announced: &sessionAnnouncements).count != 2 {
                failures.append("sessions in the same checkout did not each announce")
            }
            if !Notifier.newlyStarted(runs: sessions, announced: &sessionAnnouncements).isEmpty {
                failures.append("sessions announced more than once")
            }
        }

        for failure in failures {
            FileHandle.standardError.write(Data("FAIL: \(failure)\n".utf8))
        }
        print(failures.isEmpty ? "OK selftest (\(startedRuns.count) started runs)" : "FAILED")
        exit(failures.isEmpty ? 0 : 1)
    }

    static func printStatus() {
        do {
            let runs = try RunRegistry.load()
            print("OK registry v\(RunRegistry.supportedVersion) (\(RunRegistry.url.path))")
            if runs.isEmpty {
                print("OK no active runs")
                exit(0)
            }
            for run in runs {
                let apps = run.apps
                    .map { "\($0.name)=\($0.state.rawValue)" }
                    .joined(separator: " ")
                print("OK \(run.projectPrefix)/\(run.title) pid=\(run.pid) \(apps)")
            }
            exit(0)
        } catch {
            FileHandle.standardError.write(
                Data("ERROR: \(error.localizedDescription)\n".utf8)
            )
            exit(1)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Notifier.configure()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

struct BuncargoBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(store: model.store, stopper: model.stopper, remote: model.remote)
        } label: {
            MenuBarLabel(store: model.store)
        }
        .menuBarExtraStyle(.window)
    }
}

/// Owns the store and the stop coordinator for the lifetime of the app.
///
/// The popover's content view is created and destroyed every time the menu
/// opens and closes, so nothing that has to outlive a click can live there.
@MainActor
final class AppModel: ObservableObject {
    let store: RunStore
    let stopper: StopCoordinator
    let remote = ConnectionStore()

    init() {
        let store = RunStore()
        self.store = store
        self.stopper = StopCoordinator(store: store)
    }
}

private struct MenuBarLabel: View {
    @ObservedObject var store: RunStore

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "shippingbox")
            if store.runCount > 0 {
                Text("\(store.runCount)").monospacedDigit()
            }
        }
    }
}

struct MenuContentView: View {
    @ObservedObject var store: RunStore
    @ObservedObject var stopper: StopCoordinator
    @ObservedObject var remote: ConnectionStore

    var body: some View {
        MenuContentLayout {
            VStack(alignment: .leading, spacing: 0) {
                if store.groups.isEmpty {
                    // A registry this build cannot read is not "nothing running":
                    // say so, and say what fixes it, or the user debugs `dev`.
                    VStack(alignment: .leading, spacing: 4) {
                        Text(store.errorMessage ?? "No buncargo environments running")
                            .font(.system(size: 12))
                            .foregroundStyle(store.errorMessage == nil ? .secondary : .primary)
                        if store.isOutdated {
                            Text("Run `buncargo bar update` to catch up.")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(14)
                } else {
                    ForEach(store.groups) { group in
                        ProjectHeading(name: group.name)

                        ForEach(group.runs) { run in
                            RunRow(
                                run: run,
                                onStop: { target in stopper.request(run: run, target: target) },
                                onSimulator: { app in stopper.openSimulator(run: run, app: app) }
                            )
                        }
                    }
                }

                Divider().padding(.top, 8)
                RemoteMachinesView(store: remote)

                if let notice = stopper.notice {
                    Text(notice)
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                        .padding(.horizontal, 12)
                        .padding(.top, 6)
                }

                Divider().padding(.top, 8)

                HStack {
                    Button("Refresh") {
                        store.reload()
                        remote.refresh(force: true)
                    }
                    .buttonStyle(.link)
                    .font(.system(size: 11))
                    Spacer()
                    Button("Quit") { NSApp.terminate(nil) }
                        .buttonStyle(.link)
                        .font(.system(size: 11))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
    }
}

/// Report the menu's height during layout, before MenuBarExtra sizes its window.
struct MenuContentLayout<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        ViewThatFits(in: .vertical) {
            content()
            ScrollView { content() }
        }
        .frame(width: 320)
        .frame(maxHeight: 620)
        // A short menu uses its intrinsic height; only overflow needs a scroll view.
        // Avoid measuring into @State after opening: the window can keep that old size.
        .fixedSize(horizontal: false, vertical: true)
        .background(GeometryReader { WindowHeightFitter(height: $0.size.height) })
    }
}

/// MenuBarExtra sizes its window when the menu opens and does not shrink it
/// when the content does (a notice clearing, a run stopping, discovery
/// finishing). The content then sits at the bottom of a window that is too
/// tall, under an empty band. Follow the content instead, keeping the top edge
/// under the status item.
struct WindowHeightFitter: NSViewRepresentable {
    let height: CGFloat

    func makeNSView(context: Context) -> FitterView { FitterView() }

    func updateNSView(_ view: FitterView, context: Context) {
        view.height = height
        // Not during SwiftUI's layout pass: the window resize re-enters it.
        DispatchQueue.main.async { view.fit() }
    }

    final class FitterView: NSView {
        var height: CGFloat = 0

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            fit()
        }

        func fit() {
            guard let window, height > 0 else { return }
            let content = window.contentRect(forFrameRect: window.frame)
            guard abs(content.height - height) > 0.5 else { return }
            let resized = NSRect(
                x: content.minX, y: content.maxY - height, width: content.width, height: height
            )
            window.setFrame(window.frameRect(forContentRect: resized), display: true)
        }
    }
}
