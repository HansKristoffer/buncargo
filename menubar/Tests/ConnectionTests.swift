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
