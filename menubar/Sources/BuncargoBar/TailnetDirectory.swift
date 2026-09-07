import Foundation

struct RemoteApp: Decodable, Identifiable, Sendable {
  let name: String
  let status: String
  let url: String

  var id: String { name }
}

struct RemoteRun: Decodable, Identifiable, Sendable {
  let id: String
  let project: String
  let worktree: String?
  let branch: String?
  let apps: [RemoteApp]
}

struct RemoteDirectory: Decodable, Sendable {
  let version: Int
  let machineId: String
  let hostname: String
  let generatedAt: String
  let runs: [RemoteRun]

  func validate(host: String, expectedID: String? = nil, now: Date = Date()) throws {
    guard version == 1 else {
      throw TailnetError("Update BuncargoBar to read this remote directory")
    }

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

    guard hostname == host, !machineId.isEmpty, machineId.utf16.count <= 256,
      expectedID == nil || expectedID == machineId,
      generatedAt.range(
        of: "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$", options: .regularExpression)
        != nil,
      let timestamp = formatter.date(from: generatedAt),
      abs(timestamp.timeIntervalSince(now)) < 120,
      runs.count <= 250, Set(runs.map(\.id)).count == runs.count
    else {
      throw TailnetError(
        "Invalid or stale remote directory; check the host clock and update buncargo")
    }

    for run in runs {
      guard !run.id.isEmpty, run.id.utf16.count <= 256, run.project.utf16.count <= 256,
        (run.branch?.utf16.count ?? 0) <= 256, (run.worktree?.utf16.count ?? 0) <= 256,
        run.apps.count <= 100,
        Set(run.apps.map(\.name)).count == run.apps.count
      else {
        throw TailnetError("Invalid remote run")
      }

      for app in run.apps {
        guard !app.name.isEmpty, app.name.utf16.count <= 256, app.url.utf16.count <= 2048,
          ["starting", "ready", "reused", "stopped", "failed"].contains(app.status),
          let url = URL(string: app.url), url.scheme == "https", url.host == host,
          url.user == nil, url.password == nil, (20000...29999).contains(url.port ?? 0)
        else {
          throw TailnetError("Invalid remote app URL")
        }
      }
    }
  }
}

struct TailnetError: LocalizedError, Sendable {
  let message: String

  init(_ message: String) {
    self.message = message
  }

  var errorDescription: String? { message }
}

struct TailnetPeer: Sendable {
  let id: String?
  let endpoint: URL
}

private struct TailscaleDevice: Decodable {
  let ID: String
  let DNSName: String
  let Online: Bool?
}

private struct TailscaleStatus: Decodable {
  let BackendState: String
  let `Self`: TailscaleDevice?
  let Peer: [String: TailscaleDevice]?
}

private final class NoRemoteRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

enum TailnetDirectory {
  static let port = 48443

  static func endpoint(_ input: String) throws -> URL {
    let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      var components = URLComponents(
        string: value.contains("://") ? value : "https://\(value)"),
      components.scheme == "https", let host = components.host,
      host.range(of: "^[a-z0-9-]+\\.[a-z0-9-]+\\.ts\\.net$", options: .regularExpression)
        != nil,
      components.user == nil, components.password == nil
    else {
      throw TailnetError("Enter the full machine.tailnet.ts.net name or HTTPS directory URL")
    }

    components.port = components.port ?? port
    components.path = "/v1/runs"
    components.query = nil
    components.fragment = nil

    guard let url = components.url else {
      throw TailnetError("Invalid endpoint")
    }

    return url
  }

  static func peers() async throws -> (String?, [TailnetPeer]) {
    try await Task.detached(priority: .utility) {
      let paths = [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale",
      ]
      guard
        let binary = paths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }
        )
      else {
        throw TailnetError(
          "Tailscale CLI not found. Install Tailscale or add a machine manually.")
      }

      let process = Process()
      var environment = ProcessInfo.processInfo.environment
      environment["TAILSCALE_BE_CLI"] = "1"
      process.environment = environment
      process.executableURL = URL(fileURLWithPath: binary)
      process.arguments = ["status", "--json"]
      process.standardInput = FileHandle.nullDevice
      process.standardError = FileHandle.nullDevice
      let pipe = Pipe()
      process.standardOutput = pipe
      try process.run()
      DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
        if process.isRunning {
          kill(process.processIdentifier, SIGKILL)
        }
      }

      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      guard process.terminationStatus == 0, data.count <= 2 * 1024 * 1024 else {
        throw TailnetError("Cannot read Tailscale status")
      }

      let status = try JSONDecoder().decode(TailscaleStatus.self, from: data)
      guard status.BackendState == "Running" else {
        throw TailnetError("Connect Tailscale to discover other machines")
      }

      let peers = (status.Peer ?? [:]).values.compactMap { device -> TailnetPeer? in
        guard device.Online == true, device.ID != status.Self?.ID,
          let url = try? endpoint(
            device.DNSName.trimmingCharacters(in: CharacterSet(charactersIn: ".")))
        else {
          return nil
        }
        return TailnetPeer(id: device.ID, endpoint: url)
      }

      return (status.Self?.ID, peers)
    }.value
  }

  static func fetch(_ peer: TailnetPeer) async throws -> RemoteDirectory {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 3
    config.timeoutIntervalForResource = 5
    config.httpCookieStorage = nil

    let session = URLSession(
      configuration: config, delegate: NoRemoteRedirects(), delegateQueue: nil)
    defer {
      session.invalidateAndCancel()
    }

    let bytes: URLSession.AsyncBytes
    let response: URLResponse
    do { (bytes, response) = try await session.bytes(from: peer.endpoint) } catch {
      throw TailnetError("Unreachable: check Tailscale and access to the directory port")
    }
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw TailnetError("Directory unavailable")
    }

    var data = Data()
    for try await byte in bytes {
      guard data.count < 1024 * 1024 else {
        throw TailnetError("Directory too large")
      }
      data.append(byte)
    }

    let directory = try JSONDecoder().decode(RemoteDirectory.self, from: data)
    try directory.validate(host: peer.endpoint.host ?? "", expectedID: peer.id)
    return directory
  }
}
