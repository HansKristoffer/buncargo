import SwiftUI

/// Runs on other machines of the tailnet. Shows nothing until one answers.
struct TailnetMachinesView: View {
    @ObservedObject var store: TailnetStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(store.machines) { machine in
                Label(machine.peer.name, systemImage: "network")
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 12)
                    .padding(.top, 10)

                ForEach(groupByProject(machine.runs)) { group in
                    ProjectHeading(name: group.name)
                    ForEach(group.runs) { run in
                        TailnetRunRow(run: run, peer: machine.peer)
                    }
                }
            }
        }
        .onAppear { store.refresh() }
    }
}

/// Open and copy only: stopping, tasks and logs belong to the machine's own CLI.
private struct TailnetRunRow: View {
    let run: Run
    let peer: TailnetPeer

    private func appURL(_ app: RunApp) -> String? {
        Tailnet.reachableURL(named: app.openUrl ?? app.url, loopback: app.loopbackUrl, at: peer.address)
    }

    var body: some View {
        EnvironmentRow(title: run.title, subtitle: run.subtitle, status: .rollup(run.apps.map(\.state))) {
            if let primary = run.primary, primary.state != .stopped, let url = appURL(primary) {
                Button("Open") { Actions.open(url) }
                    .font(.system(size: 11))
                    .help("Open \(primary.name) on \(peer.name)")
            }
        } detail: {
            TargetDetailPanel(title: run.title) {
                if !run.apps.isEmpty {
                    TargetSectionHeading(title: "APPS")
                    ForEach(run.apps) { app in
                        row(app.name, app.state, appURL(app), openable: true, tablePlus: nil)
                    }
                }
                if !run.services.isEmpty {
                    TargetSectionHeading(title: "SERVICES")
                    ForEach(run.services) { service in
                        row(
                            service.name, service.state,
                            Tailnet.reachableURL(named: service.url, loopback: service.loopbackUrl, at: peer.address),
                            openable: service.isHTTP,
                            tablePlus: Tailnet.reachableURL(named: nil, loopback: service.tablePlusUrl, at: peer.address)
                        )
                    }
                }
            } footer: {
                Text("\(peer.name) · \(run.root)")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private func row(_ name: String, _ status: RunStatus, _ url: String?, openable: Bool, tablePlus: String?) -> some View {
        TargetRow(
            name: name,
            status: status,
            detail: url ?? "process",
            onOpen: openable ? url.map { url in { Actions.open(url) } } : nil,
            onCopy: url.map { url in { Actions.copy(url) } },
            onTablePlus: tablePlus.map { url in { Actions.open(url) } }
        )
    }
}
