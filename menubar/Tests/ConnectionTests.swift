import Foundation
import Testing
@testable import BuncargoBar

private func fixture() throws -> Data {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("fixtures/connect.v1.json")
    return try Data(contentsOf: path)
}
@Test func connectionFixturePreservesBranchAndDatabase() throws {
    let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: fixture())
    try directory.validate(now: Date(timeIntervalSince1970: 1788870000))
    #expect(directory.runs[0].title == "feature/checkout")
    #expect(directory.runs[0].primary?.name == "web")
    #expect(directory.runs[0].targets[1].protocol == "tcp")
    #expect(throws: (any Error).self) { try directory.validate(now: Date(timeIntervalSince1970: 1788870200)) }
}
@Test func connectionDirectoryRejectsUnsafeEndpoints() throws {
    let data = try fixture()
    let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "tcaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", with: "https://untrusted.example")
    let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: Data(text.utf8))
    #expect(throws: (any Error).self) { try directory.validate(now: Date(timeIntervalSince1970: 1788870000)) }
}
@MainActor @Test func connectionStorePublishesAndExpiresRuns() async throws {
    let data = try fixture()
    let store = ConnectionStore(deps: ConnectionDependencies(command: { _ in data }, now: { Date(timeIntervalSince1970: 1788870000) }), startTimer: false)
    store.refresh(); await store.waitForRefresh()
    #expect(store.available)
    #expect(store.runs.count == 1)
    #expect(store.runs[0].title == "feature/checkout")
    store.stop()
}

@Test func connectingTransportCannotBeOpened() throws {
    let text = String(decoding: try fixture(), as: UTF8.self).replacingOccurrences(of: "\"transport\": \"ready\"", with: "\"transport\": \"connecting\"")
    let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: Data(text.utf8))
    try directory.validate(now: Date(timeIntervalSince1970: 1788870000))
    #expect(!directory.runs[0].connected)
}

private actor ConnectionProbe {
    let directory: Data
    private(set) var calls: [[String]] = []

    init(directory: Data) { self.directory = directory }

    func command(_ args: [String]) -> Data {
        calls.append(args)
        if args == ["status"] { return directory }
        if args.first == "open" {
            if args.contains("--target=app-web") {
                return Data(#"{"url":"http://127.0.0.1:49152/authorize?token=test-token","port":49152}"#.utf8)
            }
            return Data(#"{"url":"tcp://127.0.0.1:49153","port":49153}"#.utf8)
        }
        return Data("{}".utf8)
    }
}

@MainActor private func waitForAction(_ store: ConnectionStore) async throws {
    for _ in 0..<100 {
        if !store.busy { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("Connection action did not finish")
}

@Test @MainActor func connectionActionsPreserveAuthorizationAndKeepTargetPortsSeparate() async throws {
    let data = Data(String(decoding: try fixture(), as: UTF8.self)
        .replacingOccurrences(of: "\"example\"", with: "\"A & B\"").utf8)
    let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: data)
    let run = directory.runs[0]
    let web = run.targets[0]
    let db = run.targets[1]
    let probe = ConnectionProbe(directory: data)
    var opened: [String] = []
    var copied: [String] = []
    let store = ConnectionStore(deps: ConnectionDependencies(
        command: { await probe.command($0) },
        now: { Date(timeIntervalSince1970: 1788870000) },
        open: { opened.append($0) },
        copy: { copied.append($0) }
    ), startTimer: false)
    defer { store.stop() }

    #expect(store.status(run) == .failed)
    #expect(!store.canConnect(run, web))
    store.refresh()
    await store.waitForRefresh()
    #expect(store.status(run, target: web) == .ready)
    #expect(store.canConnect(run, web))

    store.connect(run, web)
    #expect(!store.canConnect(run, web))
    try await waitForAction(store)
    let authorizedURL = "http://127.0.0.1:49152/authorize?token=test-token"
    #expect(opened == [authorizedURL])
    #expect(web.localAddress(port: 49152) == "http://127.0.0.1:49152/")

    store.connect(run, web, action: .copy)
    try await waitForAction(store)
    #expect(copied == [authorizedURL])
    store.connect(run, db)
    try await waitForAction(store)
    #expect(copied.last == db.localAddress(port: 49153))
    #expect(store.localPort(run, web) == 49152)
    #expect(store.localPort(run, db) == 49153)

    store.connect(run, db, action: .tablePlus)
    try await waitForAction(store)
    let tablePlusAddress = try #require(opened.last)
    let tablePlus = try #require(URLComponents(string: tablePlusAddress))
    #expect(tablePlus.scheme == "postgresql")
    #expect(tablePlus.port == 49153)
    #expect(tablePlus.queryItems == [URLQueryItem(name: "name", value: "A & B")])

    store.disconnect(run, web)
    try await waitForAction(store)
    #expect(store.localPort(run, web) == nil)
    #expect(store.localPort(run, db) == 49153)
    #expect(await probe.calls.last == ["disconnect", "--session=fixture-session", "--target=app-web"])
}

@Test @MainActor func connectionActionsRejectInvalidLocalAddresses() async throws {
    let run = try JSONDecoder().decode(ConnectionDirectory.self, from: fixture()).runs[0]
    for address in [
        "http://untrusted.example:49152/",
        "http://user:password@127.0.0.1:49152/",
        "https://127.0.0.1:49152/",
        "http://127.0.0.1:49153/",
    ] {
        let result = try JSONSerialization.data(withJSONObject: ["url": address, "port": 49152])
        var performed = false
        let store = ConnectionStore(deps: ConnectionDependencies(
            command: { _ in result },
            open: { _ in performed = true },
            copy: { _ in performed = true }
        ), startTimer: false)
        store.connect(run, run.targets[0])
        try await waitForAction(store)
        #expect(!performed)
        #expect(store.localPort(run, run.targets[0]) == nil)
        #expect(store.notice == "Invalid local connection")
        store.stop()
    }
}
