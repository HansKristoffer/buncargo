import Foundation
import Testing

@testable import BuncargoBar

private let now = Date(timeIntervalSince1970: 1_788_870_000)
private func fixture() throws -> Data {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("fixtures/connect.v1.json")
    return try Data(contentsOf: path)
}
@Test func directoryPreservesBranchAndDatabase() throws {
    let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: fixture())
    try directory.validate(now: now)
    #expect(directory.runs[0].title == "feature/checkout")
    #expect(directory.runs[0].primary?.name == "web")
    #expect(directory.runs[0].name == "Cursor cloud")
    #expect(directory.runs[0].id.hasPrefix(directory.runs[0].publisherId))
    #expect(directory.runs[0].targets[1].supportsTablePlus)
    // A database URL keeps its path and TablePlus query parameters.
    #expect(directory.runs[0].targets[1].url.contains("tLSMode=0"))
    #expect(throws: (any Error).self) { try directory.validate(now: now.addingTimeInterval(31)) }
}
@Test func directoryRejectsAddressesOffThisComputer() throws {
    let original = String(decoding: try fixture(), as: UTF8.self)
    for url in [
        "http://10.0.0.5:49731/",
        "http://127.0.0.1:49999/",
        "https://evil.example/",
        "http://user:secret@127.0.0.1:49731/",
        "http://127.0.0.1:49731/admin",
    ] {
        let text = original.replacingOccurrences(
            of: "http://127.0.0.1:49731/", with: url)
        let directory = try JSONDecoder().decode(ConnectionDirectory.self, from: Data(text.utf8))
        #expect(throws: (any Error).self) { try directory.validate(now: now) }
    }
    let foreign = original.replacingOccurrences(
        of: "postgresql://dev:secret@127.0.0.1:49732",
        with: "postgresql://dev:secret@db.example:49732")
    #expect(throws: (any Error).self) {
        try JSONDecoder().decode(ConnectionDirectory.self, from: Data(foreign.utf8)).validate(
            now: now)
    }
    let anonymous = original.replacingOccurrences(of: String(repeating: "c", count: 64), with: "cc")
    #expect(throws: (any Error).self) {
        try JSONDecoder().decode(ConnectionDirectory.self, from: Data(anonymous.utf8)).validate(
            now: now)
    }
}
@Test @MainActor func actionsUseTheLocalAddressWithoutConnectingFirst() async throws {
    let data = try fixture()
    var opened: [String] = []
    var copied: [String] = []
    let recorder = CommandRecorder()
    let store = ConnectionStore(
        deps: ConnectionDependencies(
            command: { args in try await recorder.run(args, data) }, now: { now },
            open: { opened.append($0) }, copy: { copied.append($0) }),
        startTimer: false)
    defer { store.stop() }
    store.refresh()
    await store.waitForRefresh()
    let run = try #require(store.runs.first)
    let web = run.targets[0]
    let db = run.targets[1]
    #expect(store.address(web) == web.url)
    #expect(store.address(db) == db.url)

    store.perform(web)
    store.perform(web, action: .copy)
    // A database has nothing to open in a browser, so its primary action copies.
    store.perform(db)
    store.perform(db, action: .tablePlus)
    #expect(opened == [web.url, db.tablePlusUrl])
    #expect(copied == [web.url, db.url])
    #expect(await recorder.calls == [["status"]])
}
@Test @MainActor func revokeNamesThePublishingComputer() async throws {
    let data = try fixture()
    let recorder = CommandRecorder()
    let store = ConnectionStore(
        deps: ConnectionDependencies(
            command: { args in try await recorder.run(args, data) }, now: { now }),
        startTimer: false)
    defer { store.stop() }
    store.refresh()
    await store.waitForRefresh()
    let run = try #require(store.runs.first)
    store.revoke(run)
    try await Task.sleep(nanoseconds: 100_000_000)
    #expect(await recorder.calls.contains(["revoke", run.publisherId]))
}

private actor CommandRecorder {
    var calls: [[String]] = []
    var fail = false
    func setFailure() { fail = true }
    func run(_ args: [String], _ data: Data) throws -> Data {
        calls.append(args)
        if fail { throw ConnectionError("Directory unavailable") }
        return data
    }
}
@Test @MainActor func failedDiscoveryClearsStaleRowsAndDisablesActions() async throws {
    let data = try fixture()
    let recorder = CommandRecorder()
    let store = ConnectionStore(
        deps: ConnectionDependencies(
            command: { args in try await recorder.run(args, data) }, now: { now }),
        startTimer: false)
    defer { store.stop() }
    store.refresh()
    await store.waitForRefresh()
    let run = try #require(store.runs.first)
    await recorder.setFailure()
    store.refresh()
    await store.waitForRefresh()
    #expect(store.runs.isEmpty)
    #expect(!store.canUse(run.targets[0]))
}
