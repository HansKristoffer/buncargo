import Foundation
import Testing
@testable import BuncargoBar

private let now = Date(timeIntervalSince1970: 1788870000)
private func fixture() throws -> Data {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("fixtures/connect.v1.json")
    return try Data(contentsOf: path)
}
@Test func directoryPreservesBranchAndDatabase() throws {
    let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: fixture())
    try directory.validate(now: now)
    #expect(directory.runs[0].title == "feature/checkout")
    #expect(directory.runs[0].primary?.name == "web")
    #expect(directory.runs[0].name == "Cursor cloud")
    #expect(directory.runs[0].targets[1].supportsTablePlus)
    #expect(throws: (any Error).self) { try directory.validate(now: now.addingTimeInterval(31)) }
}
@Test func directoryRejectsUnsafeTargetURLs() throws {
    let original = String(decoding: try fixture(), as: UTF8.self)
    for url in ["https://attacker.example/", "http://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.connect.hanskristoffer.dk/", "https://user:secret@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.connect.hanskristoffer.dk/", "https://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.connect.hanskristoffer.dk:7000/"] {
        let text = original.replacingOccurrences(of: "https://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.connect.hanskristoffer.dk/", with: url)
        let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: Data(text.utf8))
        #expect(throws: (any Error).self) { try directory.validate(now: now) }
    }
}
@Test @MainActor func browserActionsUsePublicURLWithoutStartingVisitor() async throws {
    let data = try fixture()
    var opened: [String] = [], copied: [String] = []
    let store = ConnectionStore(deps: ConnectionDependencies(command: { args in
        #expect(args == ["status"])
        return data
    }, now: { now }, open: { opened.append($0) }, copy: { copied.append($0) }), startTimer: false)
    defer { store.stop() }
    store.refresh(); await store.waitForRefresh()
    let run = try #require(store.runs.first), web = run.targets[0]
    store.perform(run, web); store.perform(run, web, action: .copy)
    #expect(opened == [web.url]); #expect(copied == [web.url])
}
@Test func databaseActionsRequireValidatedLoopbackVisitor() throws {
    let valid = TCPConnection(targetId: "db", port: 12345, url: "postgresql://postgres:secret@127.0.0.1:12345/test", tablePlusUrl: nil)
    try valid.validate(for: "db")
    #expect(throws: (any Error).self) { try valid.validate(for: "other-db") }
    let invalid = TCPConnection(targetId: "db", port: 12345, url: "postgresql://remote.example:12345/test", tablePlusUrl: nil)
    #expect(throws: (any Error).self) { try invalid.validate(for: "db") }
}

private actor Probe {
    var fail = false
    func setFailure() { fail = true }
    func read(_ data: Data) throws -> Data {
        if fail { throw ConnectionError("Directory unavailable") }
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
