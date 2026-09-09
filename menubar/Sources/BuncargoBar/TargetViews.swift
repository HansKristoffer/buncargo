import SwiftUI

/// Local and remote service addresses supply actions to the same row.
struct TargetRow: View {
    let name: String
    let status: RunStatus
    let detail: String
    var publicUrl: String? = nil
    var onOpen: (() -> Void)? = nil
    var openSymbol = "arrow.up.right"
    var openHelp = "Open"
    var onCopy: (() -> Void)? = nil
    var onTablePlus: (() -> Void)? = nil
    var onSimulator: (() -> Void)? = nil
    var onStop: (() -> Void)? = nil
    var stopHelp = "Stop"
    var actionsEnabled = true

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                StatusDot(status: status)
                Text(name)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(width: 74, alignment: .leading)
                    .help(name)
                Text(status == .stopped ? "stopped" : detail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .help(detail)

                if status != .stopped {
                    HStack(spacing: 6) {
                        if let onOpen {
                            IconButton(symbol: openSymbol, help: openHelp, action: onOpen)
                        }
                        if let onCopy {
                            IconButton(symbol: "doc.on.doc", help: "Copy address", action: onCopy)
                        }
                        if let onTablePlus, Actions.hasTablePlus {
                            IconButton(symbol: "tablecells", help: "Open in TablePlus", action: onTablePlus)
                        }
                        if let onSimulator {
                            IconButton(symbol: "iphone", help: "Open in this checkout's simulator", action: onSimulator)
                        }
                    }
                    .disabled(!actionsEnabled)
                }
                // Local cleanup remains possible when a remote service is no longer ready.
                if let onStop {
                    IconButton(symbol: "xmark", help: stopHelp, action: onStop)
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
                    IconButton(symbol: "arrow.up.right", help: "Open public URL") { Actions.open(publicUrl) }
                    IconButton(symbol: "doc.on.doc", help: "Copy public URL") { Actions.copy(publicUrl) }
                }
            }
        }
        .padding(.vertical, 1)
    }
}

struct TargetSectionHeading: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.tertiary)
            .padding(.top, 2)
    }
}

/// Both kinds of run use the same popover width, title, spacing and footer.
struct TargetDetailPanel<Content: View, Footer: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footer: () -> Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            content()
            Divider().padding(.vertical, 2)
            footer()
                .buttonStyle(.link)
                .font(.system(size: 11))
        }
        .padding(10)
        .frame(width: 460)
    }
}
