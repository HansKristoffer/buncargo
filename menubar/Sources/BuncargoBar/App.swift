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
        BuncargoBarApp.main()
    }

    static func printStatus() {
        do {
            let runs = try RunRegistry.load()
            if runs.isEmpty {
                print("OK no active runs (\(RunRegistry.url.path))")
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
            MenuContentView(store: model.store, stopper: model.stopper)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if store.groups.isEmpty {
                Text("No buncargo environments running")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .padding(14)
            } else {
                ForEach(store.groups) { group in
                    Text(group.name.uppercased())
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                        .padding(.bottom, 2)

                    ForEach(group.runs) { run in
                        RunRow(run: run) { target in
                            stopper.request(run: run, target: target)
                        }
                    }
                }
            }

            if let notice = stopper.notice {
                Text(notice)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 12)
                    .padding(.top, 6)
            }

            Divider().padding(.top, 8)

            HStack {
                Button("Refresh") { store.reload() }
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
        .frame(width: 320)
    }
}
