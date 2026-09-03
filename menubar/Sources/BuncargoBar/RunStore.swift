import Combine
import Foundation

/// Watches `~/.buncargo/runs.json` and publishes what is running.
///
/// Watches the *directory*, not the file. Every buncargo state file is written
/// through a temp file and a rename, so a file watch would hold an inode that
/// never gets written again — the same reason the hosts daemon watches
/// directories. The timer stays as the backstop: it is what notices a run whose
/// process died, which no filesystem event announces.
@MainActor
final class RunStore: ObservableObject {
    @Published private(set) var groups: [ProjectGroup] = []
    @Published private(set) var runCount = 0
    @Published private(set) var errorMessage: String?

    private var source: DispatchSourceFileSystemObject?
    private var descriptor: CInt = -1
    private var timer: Timer?
    private var reloadWorkItem: DispatchWorkItem?

    private let pollInterval: TimeInterval = 5

    init() {
        reload()
        startWatching()
        timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
    }

    // The store lives as long as the app does, so there is nothing to tear
    // down in practice. `deinit` cannot touch main-actor state under Swift 6
    // concurrency, so the cancellable parts are stopped explicitly instead.
    func stop() {
        source?.cancel()
        source = nil
        timer?.invalidate()
        timer = nil
    }

    func reload() {
        do {
            let runs = try RunRegistry.load()
            groups = groupByProject(runs)
            runCount = runs.count
            errorMessage = nil
        } catch {
            // A half-written file is a transient state, not a reason to blank
            // the menu: keep showing the last good read and say what happened.
            errorMessage = error.localizedDescription
        }
    }

    private func startWatching() {
        let directory = RunRegistry.stateDirectory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        descriptor = open(directory.path, O_EVTONLY)
        guard descriptor >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .rename, .delete],
            queue: .main
        )
        source.setEventHandler { [weak self] in self?.scheduleReload() }
        source.setCancelHandler { [descriptor] in close(descriptor) }
        source.resume()
        self.source = source
    }

    /// Coalesce the burst of events one atomic write produces (create temp,
    /// write, rename) into a single read.
    private func scheduleReload() {
        reloadWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in self?.reload() }
        }
        reloadWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: work)
    }
}
