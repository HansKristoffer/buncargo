import SwiftUI

struct RemoteMachinesView: View {
    @ObservedObject var store: ConnectionStore
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Remote environments", systemImage: "network").font(.system(size: 11, weight: .semibold))
                Spacer()
                Menu {
                    Button("Copy connection token") { store.copyToken() }
                    Button("Rotate connection token") { store.copyToken(rotate: true) }
                    Button("Revoke all sharing and rotate") { store.copyToken(rotate: true, revokeAll: true) }
                } label: { Image(systemName: "key") }
                .menuStyle(.borderlessButton).fixedSize().disabled(store.busy)
            }.padding(.horizontal, 12).padding(.top, 8)
            if let notice = store.notice {
                Text(notice).font(.system(size: 11)).foregroundStyle(.secondary).padding(.horizontal, 12)
            }
            if store.runs.isEmpty {
                Text("Copy a connection token to receive shared apps and services.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).padding(.horizontal, 12)
            }
            ForEach(Array(Set(store.runs.map(\.project))).sorted(), id: \.self) { project in
                ProjectHeading(name: project)
                ForEach(store.runs.filter { $0.project == project }) { run in
                    EnvironmentRow(title: run.title, subtitle: run.connected ? run.worktree : "Connecting…", status: store.available ? (run.connected ? .rollup(run.targets.map(\.state)) : .starting) : .failed) {
                        if let primary = run.primary {
                            Button("Open") { store.connect(run, primary) }
                                .font(.system(size: 11))
                                .help("Open \(primary.name)")
                                .disabled(!store.available || !run.connected || !primary.ready || store.busy)
                        }
                    } detail: {
                        RemoteRunDetailView(run: run, store: store)
                    }
                }
            }
        }.onAppear { store.refresh() }
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
    private var isHTTP: Bool { target.protocol == "http" }
    private var detail: String {
        if let port {
            return isHTTP ? "http://127.0.0.1:\(port)/" : "127.0.0.1:\(port)"
        }
        if !store.available { return "Unavailable" }
        if !run.connected { return "Connecting…" }
        return target.ready ? "Not connected" : target.status
    }

    var body: some View {
        TargetRow(
            name: target.name,
            status: store.available ? (run.connected ? target.state : .starting) : .failed,
            detail: detail,
            onOpen: isHTTP || port == nil ? { store.connect(run, target) } : nil,
            openSymbol: isHTTP ? "arrow.up.right" : "cable.connector",
            openHelp: isHTTP ? "Open" : "Connect and copy address",
            onCopy: { store.connect(run, target, copy: true) },
            onTablePlus: target.preset == "postgres" ? { store.connect(run, target, tablePlus: true) } : nil,
            onStop: port == nil ? nil : { store.disconnect(run, target) },
            stopHelp: "Disconnect local connection",
            actionsEnabled: store.available && run.connected && target.ready
        )
        .disabled(store.busy)
    }
}
