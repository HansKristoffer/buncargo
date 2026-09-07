import SwiftUI

struct RemoteMachinesView: View {
  @ObservedObject var store: RemoteStore
  @State private var endpoint = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Toggle("Other Tailscale devices", isOn: $store.enabled)
        .font(.system(size: 12))

      if store.enabled {
        HStack {
          TextField("machine.tailnet.ts.net", text: $endpoint)
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 11))
            .onSubmit {
              store.add(endpoint)
              endpoint = ""
            }
          Button("Add") {
            store.add(endpoint)
            endpoint = ""
          }
          .disabled(endpoint.trimmingCharacters(in: .whitespaces).isEmpty)
        }

        if let notice = store.notice {
          Text(notice)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
        }

        if store.machines.isEmpty {
          Text("No reachable buncargo devices yet")
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
        }

        ForEach(store.machines) { machine in
          VStack(alignment: .leading, spacing: 5) {
            HStack {
              Image(systemName: "desktopcomputer")
              Text(
                machine.directory?.hostname.components(separatedBy: ".").first
                  ?? machine.endpoint.host ?? "Machine"
              )
              .fontWeight(.semibold)
              Spacer()
              Button {
                store.remove(machine.endpoint)
              } label: {
                Image(systemName: "xmark")
              }
              .buttonStyle(.plain)
              .help(
                "Forget machine until it is added again or the app restarts")
            }
            .font(.system(size: 11))

            if machine.error != nil {
              Text(
                (machine.error ?? "Unavailable")
                  + (machine.lastSeen.map {
                    " · last seen \($0.formatted(date: .omitted, time: .shortened))"
                  } ?? "")
              )
              .font(.system(size: 10))
              .foregroundStyle(.secondary)
            } else if machine.directory?.runs.isEmpty == true {
              Text("No shared apps running")
                .font(.system(size: 11))
                .foregroundStyle(
                  .secondary)
            }

            ForEach(machine.directory?.runs ?? []) { run in
              Text("\(run.project) · \(run.branch ?? run.worktree ?? "Main")")
                .font(.system(size: 11, weight: .medium))
              ForEach(run.apps) { app in
                HStack(spacing: 5) {
                  StatusDot(status: RunStatus(rawValue: app.status) ?? .failed)
                  Text(app.name)
                    .font(.system(size: 11))
                  Spacer()
                  Text(app.status)
                    .font(.system(size: 10))
                    .foregroundStyle(
                      .secondary)
                  IconButton(
                    symbol: "arrow.up.right", help: "Open on this device"
                  ) { Actions.open(app.url) }
                  IconButton(symbol: "doc.on.doc", help: "Copy private URL") {
                    Actions.copy(app.url)
                  }
                }
                .disabled(
                  machine.error != nil || app.status == "stopped"
                    || app.status == "failed")
              }
            }
          }
          .padding(.vertical, 4)
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .onAppear { store.refresh() }
  }
}
