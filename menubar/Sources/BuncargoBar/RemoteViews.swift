import SwiftUI

struct RemoteMachinesView: View {
    @ObservedObject var store: ConnectionStore

    private var projects: [(name: String, runs: [RemoteRun])] {
        Dictionary(grouping: store.runs, by: { "\($0.name) · \($0.project)" })
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
                } label: { Image(systemName: "key") }.menuStyle(.borderlessButton).fixedSize()

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
                Text("Copy a connection token into BUNCARGO_CONNECT_TOKENS in your cloud environment, then run buncargo dev.")
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
            subtitle: run.worktree ?? run.hostname,
            status: store.status(run)
        ) {
            if let primary = run.primary {
                Button("Open") { store.perform(run, primary) }
                    .font(.system(size: 11))
                    .help("Open \(primary.name)")
                    .disabled(!store.canUse(primary))
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
            HStack { Text(run.hostname).font(.system(size: 10)).foregroundStyle(.secondary); Spacer(); Button("Revoke access") { store.revoke(run) }.font(.system(size: 10)) }
        }
    }
}

/// Local and remote targets share one row implementation.
struct RemoteTargetRow: View {
    let run: RemoteRun
    let target: RemoteTarget
    @ObservedObject var store: ConnectionStore

    var body: some View {
        TargetRow(
            name: target.name,
            status: store.status(run, target: target),
            detail: store.address(target),
            onOpen: { store.perform(run, target) },
            openSymbol: target.isHTTP ? "arrow.up.right" : "link",
            openHelp: target.isHTTP ? "Open" : "Connect and copy address",
            onCopy: { store.perform(run, target, action: .copy) },
            onTablePlus: target.supportsTablePlus ? { store.perform(run, target, action: .tablePlus) } : nil,
            onStop: store.connections[target.id] != nil ? { store.disconnect(target) } : nil,
            stopHelp: "Disconnect local connection",
            actionsEnabled: store.canUse(target) && !store.connecting.contains(target.id)
        )
    }
}
