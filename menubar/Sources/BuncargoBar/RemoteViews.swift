import SwiftUI

struct RemoteMachinesView: View {
    @ObservedObject var store: RemoteStore
    let stopper: StopCoordinator

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let notice = store.notice {
                message(notice)
            } else if store.machines.isEmpty {
                message("No shared environments found")
            }

            ForEach(store.machines) { machine in
                RemoteMachineView(machine: machine, stopper: stopper)
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
    let stopper: StopCoordinator

    private var projects: [String] {
        Array(Set((machine.directory?.runs ?? []).map(\.project))).sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Label(machine.name, systemImage: "desktopcomputer")
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
                    RemoteRunRow(
                        run: run,
                        available: machine.error == nil,
                        onStop: { app in
                            stopper.requestRemote(machine: machine, run: run, app: app)
                        }
                    )
                }
            }
        }
    }
}

private struct RemoteRunRow: View {
    let run: RemoteRun
    let available: Bool
    let onStop: (String?) -> Void

    private var title: String { run.branch ?? run.worktree ?? "Main" }

    var body: some View {
        EnvironmentRow(
            title: title,
            subtitle: run.branch != nil ? run.worktree : nil,
            status: available ? .rollup(run.apps.map(\.state)) : .failed
        ) {
            if let app = run.primary {
                Button("Open") { Actions.open(app.url) }
                    .font(.system(size: 11))
                    .help("Open \(app.name)")
                    .disabled(!available || !app.canOpen)
            } else {
                // Older hosts and unshared primary apps need an explicit choice, not a guess.
                Menu("Open") {
                    ForEach(run.apps) { app in
                        Button(app.name) { Actions.open(app.url) }
                            .disabled(!app.canOpen)
                    }
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .fixedSize()
                .font(.system(size: 11))
                .help("Choose a shared app")
                .disabled(!available || !run.apps.contains(where: \.canOpen))
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

                // Reuse app rows; stopping goes through the peer's daemon, never a local process.
                ForEach(run.apps) { app in
                    TargetRow(
                        name: app.name,
                        status: app.state,
                        url: app.url,
                        openable: true,
                        publicUrl: nil,
                        tablePlusUrl: nil,
                        onStop: { onStop(app.name) }
                    )
                    .disabled(!available || !app.canOpen)
                }

                Divider().padding(.vertical, 2)

                HStack {
                    Spacer()
                    Button("Stop run") { onStop(nil) }
                        .buttonStyle(.link)
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                        .disabled(!available)
                }
            }
            .padding(10)
            .frame(width: 460)
        }
    }
}

private extension RemoteApp {
    var state: RunStatus { RunStatus(rawValue: status) ?? .failed }
    var canOpen: Bool { state != .failed && state != .stopped }
}
