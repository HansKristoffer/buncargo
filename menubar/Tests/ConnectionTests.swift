import Foundation
import Testing
@testable import BuncargoBar

private let now = Date(timeIntervalSince1970: 1788870000)
private func fixture() throws -> Data {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("fixtures/tailnet.v1.json")
    return try Data(contentsOf: path)
}
@Test func directoryPreservesBranchAndDatabase() throws {
    let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: fixture())
    try directory.validate(now: now)
    #expect(directory.runs[0].title == "feature/checkout")
    #expect(directory.runs[0].primary?.name == "web")
    #expect(directory.runs[0].targets[1].tablePlusUrl != nil)
    #expect(throws: (any Error).self) { try directory.validate(now: now.addingTimeInterval(31)) }
}
@Test func directoryRejectsUnsafeTargetURLs() throws {
    let original = String(decoding: try fixture(), as: UTF8.self)
    for url in ["https://attacker.example:21000/", "http://cloud.test-tailnet.ts.net:21000/", "https://user:secret@cloud.test-tailnet.ts.net:21000/", "https://cloud.test-tailnet.ts.net:21001/"] {
        let text = original.replacingOccurrences(of: "https://cloud.test-tailnet.ts.net:21000/", with: url)
        let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: Data(text.utf8))
        #expect(throws: (any Error).self) { try directory.validate(now: now) }
    }
    for url in ["postgresql://postgres:postgres@attacker.example:21001/example", "postgresql://postgres:postgres@cloud.test-tailnet.ts.net:21000/example", "https://cloud.test-tailnet.ts.net:21001/"] {
        let text = original.replacingOccurrences(of: "postgresql://postgres:postgres@cloud.test-tailnet.ts.net:21001/example?env=development&name=example-db&tLSMode=0", with: url)
        let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: Data(text.utf8))
        #expect(throws: (any Error).self) { try directory.validate(now: now) }
    }
}
@Test @MainActor func actionsUseDirectTailnetAddressesWithoutStartingLocalForwards() async throws {
    let data = try fixture()
    var opened: [String] = [], copied: [String] = []
    let store = ConnectionStore(deps: ConnectionDependencies(command: { args in
        #expect(args == ["status"])
        return data
    }, now: { now }, open: { opened.append($0) }, copy: { copied.append($0) }), startTimer: false)
    defer { store.stop() }
    store.refresh(); await store.waitForRefresh()
    #expect(store.available)
    let run = try #require(store.runs.first), web = run.targets[0], db = run.targets[1]
    store.perform(run, web)
    store.perform(run, web, action: .copy)
    store.perform(run, db)
    store.perform(run, db, action: .tablePlus)
    #expect(opened[0] == web.url)
    #expect(copied == [web.url, "cloud.test-tailnet.ts.net:21001"])
    let address = try #require(URLComponents(string: opened[1]))
    #expect(address.scheme == "postgresql")
    #expect(address.host == run.hostname)
    #expect(address.port == db.port)
    #expect(address.password == "postgres")
}
private actor Probe {
    var fail = false
    func setFailure() { fail = true }
    func read(_ data: Data) throws -> Data {
        if fail { throw ConnectionError("Tailscale disconnected") }
        return data
    }
}
@Test @MainActor func failedDiscoveryClearsStaleRowsAndDisablesActions() async throws {
    let data = try fixture(), probe = Probe()
    let store = ConnectionStore(deps: ConnectionDependencies(command: { _ in try await probe.read(data) }, now: { now }), startTimer: false)
    defer { store.stop() }
    store.refresh(); await store.waitForRefresh()
    let run = try #require(store.runs.first)
    await probe.setFailure()
    store.refresh(); await store.waitForRefresh()
    #expect(store.runs.isEmpty)
    #expect(!store.canUse(run.targets[0]))
}
