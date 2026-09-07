import Foundation
import Testing

@testable import BuncargoBar

private actor Responses {
  var calls: [URL] = []
  var gates: [URL: CheckedContinuation<RemoteDirectory, any Error>] = [:]
  var delayed = false
  var failure = false

  func setDelayed(_ value: Bool) { delayed = value }

  func setFailure(_ value: Bool) { failure = value }

  func count() -> Int { calls.count }

  func pending() -> Bool { !gates.isEmpty }

  func fetch(_ peer: TailnetPeer) async throws -> RemoteDirectory {
    calls.append(peer.endpoint)
    if failure { throw TailnetError("Unreachable") }
    if delayed { return try await withCheckedThrowingContinuation { gates[peer.endpoint] = $0 } }
    return directory(peer.endpoint)
  }

  func release() {
    for (url, gate) in gates { gate.resume(returning: directory(url)) }
    gates = [:]
  }
}

private func directory(_ endpoint: URL) -> RemoteDirectory {
  RemoteDirectory(
    version: 1, machineId: "remote", hostname: endpoint.host!,
    generatedAt: "2026-09-07T12:00:00.000Z", runs: [])
}

private let endpoint = URL(string: "https://devbox.tail123.ts.net:48443/v1/runs")!

@MainActor

private func setup(
  _ responses: Responses,
  peers: @escaping @Sendable () async throws -> (String?, [TailnetPeer]) = { ("local", []) }
) -> (RemoteStore, UserDefaults, String) {
  let suite = "buncargo-tests-\(UUID().uuidString)"
  let preferences = UserDefaults(suiteName: suite)!
  let store = RemoteStore(
    preferences: preferences,
    deps: RemoteDependencies(
      peers: peers, fetch: { try await responses.fetch($0) },
      now: { Date(timeIntervalSince1970: 1000) }), startTimer: false)
  return (store, preferences, suite)
}

@Test @MainActor
func manualWorksWithoutCLIAndEmptyIsSuccessful() async {
  let responses = Responses()
  let (store, preferences, suite) = setup(responses, peers: { throw TailnetError("CLI absent") })

  defer {
    store.enabled = false
    preferences.removePersistentDomain(forName: suite)
  }

  store.add(endpoint.absoluteString)
  await store.waitForRefresh()

  #expect(store.machines.count == 1)
  #expect(store.machines.first?.directory?.runs.isEmpty == true)
  #expect(store.machines.first?.error == nil)
  #expect(store.notice == "CLI absent")
}

@Test @MainActor
func deduplicatesMachineAcrossManualAndAutomaticEndpoints() async {
  let responses = Responses()
  let automatic = TailnetPeer(id: "remote", endpoint: endpoint)
  let (store, preferences, suite) = setup(responses, peers: { ("local", [automatic]) })

  defer {
    store.enabled = false
    preferences.removePersistentDomain(forName: suite)
  }

  store.add("https://devbox.tail123.ts.net:49000")
  await store.waitForRefresh()

  #expect(store.machines.count == 1)
  #expect(store.machines.first?.id == "remote")
}

@Test @MainActor
func discardsLateResponseAfterForget() async {
  let responses = Responses()
  let (store, preferences, suite) = setup(responses)

  defer {
    store.enabled = false
    preferences.removePersistentDomain(forName: suite)
  }

  store.add(endpoint.absoluteString)
  await store.waitForRefresh()
  // Hold an old request open while the user forgets the machine.
  await responses.setDelayed(true)
  store.refresh(force: true)
  while !(await responses.pending()) { await Task.yield() }
  store.remove(endpoint)

  // Deliver the old result after the user action; it must not restore stale UI state.
  await responses.release()

  for _ in 0..<20 { await Task.yield() }
  #expect(store.machines.isEmpty)
}

@Test @MainActor
func disableAndReenableInvalidateOldWork() async {
  let responses = Responses()
  let (store, preferences, suite) = setup(responses)

  defer {
    store.enabled = false
    preferences.removePersistentDomain(forName: suite)
  }

  await responses.setDelayed(true)
  store.add(endpoint.absoluteString)
  while !(await responses.pending()) { await Task.yield() }
  store.enabled = false
  await responses.setDelayed(false)
  store.enabled = true
  await store.waitForRefresh()

  #expect(store.machines.count == 1)

  // Deliver the old result after the user action; it must not restore stale UI state.
  await responses.release()

  for _ in 0..<20 { await Task.yield() }
  #expect(store.machines.count == 1)
}

@Test @MainActor
func menuRefreshHonorsBackoffAndExplicitRefreshRetries() async {
  let responses = Responses()
  let (store, preferences, suite) = setup(responses)

  defer {
    store.enabled = false
    preferences.removePersistentDomain(forName: suite)
  }

  store.add(endpoint.absoluteString)
  await store.waitForRefresh()
  await responses.setFailure(true)
  store.refresh(force: true)
  await store.waitForRefresh()
  let count = await responses.count()
  #expect(store.machines.first?.error == "Unreachable")
  #expect(store.machines.first?.lastSeen != nil)

  // Opening the menu respects backoff; the explicit refresh remains a deliberate retry.
  store.refresh()
  await store.waitForRefresh()

  #expect(await responses.count() == count)
  store.refresh(force: true)
  await store.waitForRefresh()

  #expect(await responses.count() > count)
}

@Test
func rejectsMalformedDirectoryVariations() throws {
  let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
  let raw = try Data(contentsOf: root.appendingPathComponent("fixtures/tailnet.v1.json"))
  let fixture = try #require(JSONSerialization.jsonObject(with: raw) as? [String: Any])
  let now = Date(timeIntervalSince1970: 1_788_782_400)

  let valid = try JSONDecoder().decode(RemoteDirectory.self, from: raw)
  try valid.validate(host: "devbox.tail123.ts.net", expectedID: "fixture-machine", now: now)

  // Keep malformed cases next to the assertions instead of copying entire directory documents.
  func reject(_ name: String, patch: [String: Any]) throws {
    let document = fixture.merging(patch) { _, replacement in replacement }
    let data = try JSONSerialization.data(withJSONObject: document)

    #expect(throws: (any Error).self, Comment(rawValue: name)) {
      let directory = try JSONDecoder().decode(RemoteDirectory.self, from: data)
      try directory.validate(host: "devbox.tail123.ts.net", expectedID: "fixture-machine", now: now)
    }
  }

  let metadata: [(String, [String: Any])] = [
    ("unsupported version", ["version": 2]),
    ("stale timestamp", ["generatedAt": "2026-09-07T11:00:00.000Z"]),
    ("future timestamp", ["generatedAt": "2026-09-07T13:00:00.000Z"]),
    ("wrong identity", ["machineId": "other"]),
    ("wrong host", ["hostname": "other.tail123.ts.net"]),
  ]

  for (name, patch) in metadata {
    try reject(name, patch: patch)
  }

  let runs = try #require(fixture["runs"] as? [[String: Any]])
  let run = try #require(runs.first)
  let apps = try #require(run["apps"] as? [[String: Any]])
  let app = try #require(apps.first)
  var missingApps = run
  missingApps.removeValue(forKey: "apps")

  try reject("duplicate run", patch: ["runs": [run, run]])
  try reject("missing apps", patch: ["runs": [missingApps]])

  let invalidRuns: [(String, [String: Any])] = [
    ("duplicate app", ["apps": apps + [app]]),
    ("invalid branch", ["branch": String(repeating: "a", count: 257)]),
  ]

  for (name, patch) in invalidRuns {
    let changed = run.merging(patch) { _, replacement in replacement }
    try reject(name, patch: ["runs": [changed]])
  }

  let invalidApps: [(String, [String: Any])] = [
    ("unsafe scheme", ["url": "file:///etc/passwd"]),
    ("wrong app host", ["url": "https://other.tail123.ts.net:25173"]),
    ("invalid app port", ["url": "https://devbox.tail123.ts.net:443"]),
    ("URL credentials", ["url": "https://user@devbox.tail123.ts.net:25173"]),
    ("invalid status", ["status": "unknown"]),
    ("empty app name", ["name": ""]),
  ]

  for (name, patch) in invalidApps {
    let changed = app.merging(patch) { _, replacement in replacement }
    let changedRun = run.merging(["apps": [changed] + Array(apps.dropFirst())]) {
      _, replacement in replacement
    }

    try reject(name, patch: ["runs": [changedRun]])
  }
}
