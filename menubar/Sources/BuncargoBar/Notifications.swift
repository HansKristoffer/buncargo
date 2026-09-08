import UserNotifications

/// A local notification when a run's main app comes up.
///
/// Only the first time per run: `startedAt` is part of the key, so restarting a
/// worktree notifies again but a flapping status does not.
@MainActor
enum Notifier {
    nonisolated static let openAction = "open"
    nonisolated static let copyAction = "copy"
    nonisolated static let urlKey = "url"
    private static let category = "run.started"

    private static let delegate = NotifierDelegate()

    /// Unbundled builds (`swift run`) have no bundle identifier, and
    /// `UNUserNotificationCenter.current()` traps for those instead of failing.
    private static var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    static func configure() {
        guard isAvailable else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = delegate
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: category,
                actions: [
                    UNNotificationAction(identifier: openAction, title: "Open"),
                    UNNotificationAction(identifier: copyAction, title: "Copy URL"),
                ],
                intentIdentifiers: []
            )
        ])
        // The completion-handler form would be inferred @MainActor here and
        // trap when UserNotifications calls it on its own queue; async is safe.
        Task { _ = try? await center.requestAuthorization(options: [.alert]) }
    }

    static func runStarted(_ run: Run) {
        guard isAvailable, let primary = run.primary else { return }
        let url = Actions.preferredURL(
            named: primary.url,
            loopback: primary.loopbackUrl,
            hostsActive: run.hosts?.active ?? false
        )

        let content = UNMutableNotificationContent()
        content.title = "\(run.projectName) · \(run.title) started"
        content.subtitle = run.branch ?? primary.name
        content.body = url
        content.categoryIdentifier = category
        content.userInfo = [urlKey: url]

        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: key(run), content: content, trigger: nil)
        )
    }

    nonisolated static func key(_ run: Run) -> String { "\(run.id)@\(run.startedAt)" }

    /// Runs whose main app is up and has not been announced yet.
    ///
    /// `announced` is pruned to the live runs first, so a key is forgotten only
    /// once its run is gone — a run that goes ready → starting → ready stays
    /// quiet.
    nonisolated static func newlyStarted(runs: [Run], announced: inout Set<String>) -> [Run] {
        announced.formIntersection(Set(runs.map(key)))
        return runs.filter { run in
            run.primary?.state.isUp == true && announced.insert(key(run)).inserted
        }
    }
}

/// Notification clicks. The default action (the banner body) opens too.
final class NotifierDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // The popover makes the app active; without this the banner would be
        // swallowed exactly when the user is looking at buncargo.
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let action = response.actionIdentifier
        if let url = response.notification.request.content.userInfo[Notifier.urlKey] as? String {
            Task { @MainActor in
                switch action {
                case Notifier.copyAction: Actions.copy(url)
                case Notifier.openAction, UNNotificationDefaultActionIdentifier: Actions.open(url)
                default: break
                }
            }
        }
        completionHandler()
    }
}
