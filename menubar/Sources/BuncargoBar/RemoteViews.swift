import SwiftUI

struct RemoteMachinesView: View {
    @ObservedObject var store: ConnectionStore

    private var projects: [(name: String, runs: [RemoteRun])] {
        Dictionary(grouping: store.runs, by: \.project)
            .map { (name: $0.key, runs: $0.value) }
            .sorted { $0.name < $1.name }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Remote environments", systemImage: "network")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
                Menu {
                    Button("Copy connection token") { store.copyToken() }
                    Button("Rotate connection token") { store.copyToken(rotate: true) }
                    Button("Revoke all sharing and rotate") { store.copyToken(rotate: true, revokeAll: true) }
                } label: {
                    Image(systemName: "key")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(store.busy)
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)

            if let notice = store.notice {
                Text(notice)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
            }
            if store.runs.isEmpty {
                Text("Copy a connection token to receive shared apps and services.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
            }
            ForEach(projects, id: \.name) { project in
                ProjectHeading(name: project.name)
                ForEach(project.runs) { run in
                    RemoteRunRow(run: run, store: store)
                }
            }
        }
        .onAppear { store.refresh() }
    }
}

private struct RemoteRunRow: View {
    let run: RemoteRun
    @ObservedObject var store: ConnectionStore

    var body: some View {
        EnvironmentRow(
            title: run.title,
            subtitle: run.connected ? run.worktree : "Connecting…",
            status: store.status(run)
        ) {
            if let primary = run.primary {
                Button("Open") { store.connect(run, primary) }
                    .font(.system(size: 11))
                    .help("Open \(primary.name)")
                    .disabled(!store.canConnect(run, primary))
            }
        } detail: {
            RemoteRunDetailView(run: run, store: store)
        }
    }
}

struct RemoteRunDetailView: View {
    let run: RemoteRun
    @ObservedObject var store: ConnectionStore

    var body: some View {
        TargetDetailPanel(title: run.title) {
            ForEach(["app", "service"], id: \.self) { kind in
                let targets = run.targets.filter { $0.kind == kind }
                if !targets.isEmpty {
                    TargetSectionHeading(title: kind == "app" ? "APPS" : "SERVICES")
                    ForEach(targets) { target in
                        RemoteTargetRow(run: run, target: target, store: store)
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                Button("Revoke this sharing") { store.revoke(run) }
                    .foregroundStyle(.red)
                    .disabled(store.busy)
            }
        }
    }
}

/// Remote actions always go through the CLI, even when a local address is already known.
/// In particular, opening a browser needs a fresh authorization URL, not the display address.
struct RemoteTargetRow: View {
    let run: RemoteRun
    let target: RemoteTarget
    @ObservedObject var store: ConnectionStore

    private var port: Int? { store.localPort(run, target) }
    private var detail: String {
        if let port {
            return target.localAddress(port: port)
        }
        if !store.available { return "Unavailable" }
        if !run.connected { return "Connecting…" }
        return target.ready ? "Not connected" : target.status
    }

    var body: some View {
        TargetRow(
            name: target.name,
            status: store.status(run, target: target),
            detail: detail,
            onOpen: target.isHTTP || port == nil ? { store.connect(run, target) } : nil,
            openSymbol: target.isHTTP ? "arrow.up.right" : "cable.connector",
            openHelp: target.isHTTP ? "Open" : "Connect and copy address",
            onCopy: { store.connect(run, target, action: .copy) },
            onTablePlus: target.isPostgres ? { store.connect(run, target, action: .tablePlus) } : nil,
            onStop: port == nil ? nil : { store.disconnect(run, target) },
            stopHelp: "Disconnect local connection",
            actionsEnabled: store.canConnect(run, target)
        )
        .disabled(store.busy)
    }
}
