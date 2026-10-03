import AppKit
import SwiftUI

/// Status colours, shared by every dot in the UI.
extension RunStatus {
    /// Stopped apps do not hide a failure or startup among the remaining apps.
    static func rollup(_ states: [RunStatus]) -> RunStatus {
        let active = states.filter { $0 != .stopped }

        if active.isEmpty { return states.isEmpty ? .starting : .stopped }
        if active.contains(.failed) { return .failed }
        if active.contains(.starting) { return .starting }

        return .ready
    }

    var tint: Color {
        switch self {
        case .ready, .reused: return .green
        case .starting: return .yellow
        case .failed: return .red
        case .stopped: return .secondary
        }
    }
}

struct StatusDot: View {
    let status: RunStatus

    var body: some View {
        Circle()
            .fill(status.tint)
            .frame(width: 7, height: 7)
            .opacity(status == .stopped ? 0.5 : 1)
    }
}

/// A small icon button that keeps its hit area predictable in a dense row.
struct IconButton: View {
    let symbol: String
    let help: String
    var tint: Color = .secondary
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(hovering ? .primary : tint)
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
        .onHover { hovering = $0 }
    }
}

/// Only local action wiring lives here; spacing and controls belong to TargetRow.
struct LocalTargetRow: View {
    let name: String
    let status: RunStatus
    let url: String
    let openable: Bool
    let publicUrl: String?
    let tablePlusUrl: String?
    var onStop: (() -> Void)? = nil
    var onSimulator: (() -> Void)? = nil

    var body: some View {
        TargetRow(
            name: name,
            status: status,
            detail: url.isEmpty ? "process" : url,
            publicUrl: publicUrl,
            onOpen: openable ? { Actions.open(url) } : nil,
            onCopy: url.isEmpty ? nil : { Actions.copy(url) },
            onTablePlus: tablePlusUrl.map { url in { Actions.open(url) } },
            onSimulator: onSimulator,
            onStop: status == .stopped ? nil : onStop
        )
    }
}

/// A labelled value: open it when it is a URL, copy it either way.
struct DetailRow: View {
    let label: String
    let value: String
    var isURL = false

    var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 110, alignment: .leading)
            Text(value)
                .font(.system(size: 11))
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(value)
            if isURL {
                IconButton(symbol: "arrow.up.right", help: "Open \(label)") { Actions.open(value) }
            }
            IconButton(symbol: "doc.on.doc", help: "Copy") { Actions.copy(value) }
        }
    }
}

/// A config task with its run button, spinning while it runs.
struct TaskRow: View {
    let task: RunTask
    let running: Bool
    let onRun: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                Text(task.name)
                    .font(.system(size: 12))
                if let description = task.description {
                    Text(description)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if running {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 18, height: 18)
            } else {
                IconButton(symbol: "play.fill", help: "Run \(task.name)", action: onRun)
            }
        }
    }
}

/// The hover panel: every app and service of one run.
struct RunDetailView: View {
    let run: Run
    let onStop: (String?) -> Void
    let onSimulator: (String) -> Void
    let onRunTask: (String) -> Void
    let isRunningTask: (String) -> Bool

    private var hostsActive: Bool { run.hosts?.active ?? false }

    var body: some View {
        TargetDetailPanel(title: run.title) {
            if !run.apps.isEmpty {
                TargetSectionHeading(title: "APPS")
                ForEach(run.apps) { app in
                    LocalTargetRow(
                        name: app.name,
                        status: app.state,
                        url: app.preferredURL(hostsActive: hostsActive),
                        openable: app.url != nil || app.openUrl != nil,
                        publicUrl: app.publicUrl,
                        tablePlusUrl: nil,
                        onStop: { onStop(app.name) },
                        onSimulator: app.hasSimulator ? { onSimulator(app.name) } : nil
                    )
                }
            }

            if !run.services.isEmpty {
                TargetSectionHeading(title: "SERVICES")
                ForEach(run.services) { service in
                    LocalTargetRow(
                        name: service.name,
                        status: service.state,
                        url: Actions.preferredURL(
                            named: service.url,
                            loopback: service.loopbackUrl,
                            hostsActive: hostsActive && service.hostname != nil
                        ),
                        openable: service.isHTTP,
                        publicUrl: service.publicUrl,
                        tablePlusUrl: service.tablePlusUrl,
                        onStop: { onStop(service.name) }
                    )
                }
            }

            let leases = run.apps.compactMap { app in app.exclusive.map { (app.name, $0) } }
            if !(run.details ?? []).isEmpty || !leases.isEmpty {
                TargetSectionHeading(title: "DETAILS")
                ForEach(run.details ?? []) { detail in
                    DetailRow(label: detail.label, value: detail.value, isURL: detail.isURL)
                }
                ForEach(leases, id: \.0) { lease in
                    DetailRow(label: "Lease (\(lease.0))", value: lease.1)
                }
            }

            if let tasks = run.tasks, !tasks.isEmpty {
                TargetSectionHeading(title: "TASKS")
                ForEach(tasks) { task in
                    TaskRow(
                        task: task,
                        running: isRunningTask(task.name),
                        onRun: { onRunTask(task.name) }
                    )
                }
            }
        } footer: {
            HStack(spacing: 10) {
                Button("Reveal in Finder") { Actions.revealInFinder(run.root) }
                Spacer()
                Button("Stop run") { onStop(nil) }
                    .foregroundStyle(.red)
            }
        }
    }
}

/// One checkout: status dot, name, branch, Open, and the detail chevron.
struct RunRow: View {
    let run: Run
    let onStop: (String?) -> Void
    let onSimulator: (String) -> Void
    let onRunTask: (String) -> Void
    let isRunningTask: (String) -> Bool

    var body: some View {
        EnvironmentRow(
            title: run.title,
            subtitle: run.subtitle,
            status: .rollup(run.apps.map(\.state))
        ) {
            if let primary = run.primary, primary.state != .stopped {
                Button("Open") {
                    Actions.open(primary.preferredURL(hostsActive: run.hosts?.active ?? false))
                }
                .font(.system(size: 11))
                .help("Open \(primary.name)")
            }

            if let expo = run.simulatorApp {
                IconButton(symbol: "iphone", help: "Open \(expo.name) in this checkout's simulator") {
                    onSimulator(expo.name)
                }
            }
        } detail: {
            RunDetailView(
                run: run,
                onStop: onStop,
                onSimulator: onSimulator,
                onRunTask: onRunTask,
                isRunningTask: isRunningTask
            )
        }
    }
}

struct ProjectHeading: View {
    let name: String

    var body: some View {
        Text(name.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 2)
    }
}

/// Local and remote runs share presentation, while keeping their available actions separate.
struct EnvironmentRow<RowActions: View, Detail: View>: View {
    let title: String
    let subtitle: String?
    let status: RunStatus
    @ViewBuilder var actions: () -> RowActions
    @ViewBuilder var detail: () -> Detail

    @State private var showingDetail = false
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(status: status)

            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))

                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()
            actions()

            IconButton(
                symbol: showingDetail ? "chevron.up" : "chevron.down",
                help: "Apps and services"
            ) {
                showingDetail.toggle()
            }
            // Both hover and click work, including with tiling window managers.
            .onHover { inside in
                if inside { showingDetail = true }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(hovering ? Color.primary.opacity(0.06) : .clear)
        .onHover { hovering = $0 }
        .popover(isPresented: $showingDetail, arrowEdge: .trailing) {
            detail()
        }
    }
}
