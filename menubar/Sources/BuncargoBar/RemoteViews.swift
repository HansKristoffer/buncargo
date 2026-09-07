import SwiftUI

struct RemoteMachinesView: View {
    @ObservedObject var store: RemoteStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let notice = store.notice {
                message(notice)
            } else if store.machines.isEmpty {
                message("No shared environments found")
            }

            ForEach(store.machines) { machine in
                RemoteMachineView(machine: machine)
            }
        }
        .onAppear { store.refresh() }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
    }
}

private struct RemoteMachineView: View {
    let machine: RemoteMachine

    private var name: String {
        let hostname = machine.directory?.hostname ?? machine.endpoint.host ?? "Machine"
        return hostname.components(separatedBy: ".").first ?? hostname
    }

    private var projects: [String] {
        Array(Set((machine.directory?.runs ?? []).map(\.project))).sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Label(name, systemImage: "desktopcomputer")
                .font(.system(size: 11, weight: .semibold))
                .padding(.horizontal, 12)
                .padding(.top, 8)

            if let error = machine.error {
                Text(error)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 4)

                if let lastSeen = machine.lastSeen {
                    Text("Last seen \(lastSeen.formatted(date: .omitted, time: .shortened))")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                }
            } else if machine.directory?.runs.isEmpty == true {
                Text("No shared apps running")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
            }

            ForEach(projects, id: \.self) { project in
                ProjectHeading(name: project)

                ForEach((machine.directory?.runs ?? []).filter { $0.project == project }) { run in
                    RemoteRunRow(run: run, available: machine.error == nil)
                }
            }
        }
    }
}

private struct RemoteRunRow: View {
    let run: RemoteRun
    let available: Bool

    private var title: String { run.branch ?? run.worktree ?? "Main" }

    var body: some View {
        EnvironmentRow(
            title: title,
            subtitle: run.branch != nil ? run.worktree : nil,
            status: available ? .rollup(run.apps.map(\.state)) : .failed
        ) {
            // The directory has no primary-app designation; use its first available app.
            if let app = run.apps.first(where: { $0.state != .stopped && $0.state != .failed }) {
                Button("Open") { Actions.open(app.url) }
                    .font(.system(size: 11))
                    .help("Open \(app.name)")
                    .disabled(!available)
            }
        } detail: {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)

                Text("APPS")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.top, 2)

                // Reuse app rows, but never offer local process or filesystem actions for a peer.
                ForEach(run.apps) { app in
                    TargetRow(
                        name: app.name,
                        status: app.state,
                        url: app.url,
                        openable: true,
                        publicUrl: nil,
                        tablePlusUrl: nil
                    )
                    .disabled(!available || app.state == .failed || app.state == .stopped)
                }
            }
            .padding(10)
            .frame(width: 460)
        }
    }
}

private extension RemoteApp {
    var state: RunStatus { RunStatus(rawValue: status) ?? .failed }
}
