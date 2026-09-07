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
        .onHover { hovering = $0 }
    }
}

/// One app or service line inside the detail panel.
struct TargetRow: View {
    let name: String
    let status: RunStatus
    let url: String
    let openable: Bool
    let publicUrl: String?
    let tablePlusUrl: String?
    var onStop: (() -> Void)? = nil
    var onSimulator: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                StatusDot(status: status)
                Text(name)
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 74, alignment: .leading)
                Text(status == .stopped ? "stopped" : url)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if status != .stopped {
                    if openable {
                        IconButton(symbol: "arrow.up.right", help: "Open") {
                            Actions.open(url)
                        }
                    }
                    IconButton(symbol: "doc.on.doc", help: "Copy URL") {
                        Actions.copy(url)
                    }
                    if let tablePlusUrl, Actions.hasTablePlus {
                        IconButton(symbol: "tablecells", help: "Open in TablePlus") {
                            Actions.open(tablePlusUrl)
                        }
                    }
                    if let onSimulator {
                        IconButton(symbol: "iphone", help: "Open in this checkout's simulator") {
                            onSimulator()
                        }
                    }
                    if let onStop {
                        IconButton(symbol: "xmark", help: "Stop", tint: .secondary) {
                            onStop()
                        }
                    }
                }
            }

            if let publicUrl, status != .stopped {
                HStack(spacing: 6) {
                    Spacer().frame(width: 87)
                    Text(publicUrl)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    IconButton(symbol: "arrow.up.right", help: "Open public URL") {
                        Actions.open(publicUrl)
                    }
                    IconButton(symbol: "doc.on.doc", help: "Copy public URL") {
                        Actions.copy(publicUrl)
                    }
                }
            }
        }
        .padding(.vertical, 1)
    }
}

/// The hover panel: every app and service of one run.
struct RunDetailView: View {
    let run: Run
    let onStop: (String?) -> Void
    let onSimulator: (String) -> Void

    private var hostsActive: Bool { run.hosts?.active ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(run.title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)

            if !run.apps.isEmpty {
                sectionHeader("APPS")
                ForEach(run.apps) { app in
                    TargetRow(
                        name: app.name,
                        status: app.state,
                        url: app.tailnetUrl ?? Actions.preferredURL(
                            named: app.url,
                            loopback: app.loopbackUrl,
                            hostsActive: hostsActive
                        ),
                        openable: true,
                        publicUrl: app.publicUrl,
                        tablePlusUrl: nil,
                        onStop: { onStop(app.name) },
                        onSimulator: app.hasSimulator ? { onSimulator(app.name) } : nil
                    )
                }
            }

            if !run.services.isEmpty {
                sectionHeader("SERVICES")
                ForEach(run.services) { service in
                    TargetRow(
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

            Divider().padding(.vertical, 2)

            HStack(spacing: 10) {
                Button("Reveal in Finder") { Actions.revealInFinder(run.root) }
                    .buttonStyle(.link)
                    .font(.system(size: 11))
                Spacer()
                Button("Stop run") { onStop(nil) }
                    .buttonStyle(.link)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
            }
        }
        .padding(10)
        .frame(width: 460)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.tertiary)
            .padding(.top, 2)
    }
}

/// One checkout: status dot, name, branch, Open, and the detail chevron.
struct RunRow: View {
    let run: Run
    let onStop: (String?) -> Void
    let onSimulator: (String) -> Void

    var body: some View {
        EnvironmentRow(
            title: run.title,
            subtitle: run.subtitle,
            status: .rollup(run.apps.map(\.state))
        ) {
            if let primary = run.primary, primary.state != .stopped {
                Button("Open") {
                    Actions.open(
                        primary.tailnetUrl ?? Actions.preferredURL(
                            named: primary.url,
                            loopback: primary.loopbackUrl,
                            hostsActive: run.hosts?.active ?? false
                        )
                    )
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
            RunDetailView(run: run, onStop: onStop, onSimulator: onSimulator)
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
