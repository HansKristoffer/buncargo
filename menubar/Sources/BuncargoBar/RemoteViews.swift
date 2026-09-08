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
                                .disabled(!store.available || !run.connected || !primary.ready || store.busy)
                        }
                    } detail: {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(run.project) · \(run.title)").font(.headline)
                            ForEach(run.targets) { target in
                                HStack {
                                    Text(target.name)
                                    Text(target.status).foregroundStyle(.secondary)
                                    Spacer()
                                    Button(target.protocol == "http" ? "Open" : "Connect") { store.connect(run, target) }
                                    Button("Copy") { store.connect(run, target, copy: true) }
                                    if target.preset == "postgres" && Actions.hasTablePlus {
                                        Button("TablePlus") { store.connect(run, target, tablePlus: true) }
                                    }
                                    if let port = store.connected["\(run.id):\(target.id)"] {
                                        Text(":\(port)").foregroundStyle(.secondary)
                                        Button("Disconnect") { store.disconnect(run, target) }
                                    }
                                }.disabled(!store.available || !run.connected || !target.ready || store.busy)
                            }
                            Button("Revoke this sharing") { store.revoke(run) }.disabled(store.busy)
                        }.font(.system(size: 11)).padding(12).frame(minWidth: 460)
                    }
                }
            }
        }.onAppear { store.refresh() }
    }
}
