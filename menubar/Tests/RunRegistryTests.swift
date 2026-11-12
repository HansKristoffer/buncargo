import Foundation
import Testing

@testable import BuncargoBar

private func fixtureRuns(_ name: String = "runs.v2.json") throws -> [Run] {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("fixtures/\(name)")
    return try JSONDecoder().decode(RunsFile.self, from: Data(contentsOf: path)).runs
}

/// One entry this build could not decode emptied the whole menu.
/// `src/core/run-registry.fixture.test.ts` reads the same fixture.
@Test func entriesThatDoNotDecodeAreDroppedAndTheRestKept() throws {
    let runs = try fixtureRuns("runs.v2.lossy.json")
    #expect(
        runs.map(\.sessionId) == ["first-valid-session", "unknown-status-session", "last-valid-session"])

    let unknown = try #require(runs.first(where: { $0.sessionId == "unknown-status-session" }))
    #expect(unknown.apps.first?.state == .starting)
    #expect(unknown.services.first?.state == .starting)
}

/// The CLI hashes what `ps -o lstart=` prints in the C locale and UTC; these
/// are the same values `src/core/process-identity.ts` produces.
@Test func identityIsEncodedAsTheCLIEncodesIt() {
    #expect(ProcessIdentity.lstart(0) == "Thu Jan  1 00:00:00 1970")
    #expect(ProcessIdentity.lstart(1_700_000_000) == "Tue Nov 14 22:13:20 2023")
    #expect(
        ProcessIdentity.encode(startSeconds: 0)
            == "v2:0225406240ab2c27b47bb671d9013e40d3124b018d1e2d761ba60b0202fee8c2")
    #expect(
        ProcessIdentity.encode(startSeconds: 1_700_000_000)
            == "v2:f72f3ae6dd517584f47dca012d920d5b25d19f0176837248f72a00b82724de45")
}

@Test func thisProcessReadsAsItself() throws {
    let born = try #require(ProcessIdentity.startSeconds(pid: getpid()))
    let probe = OwnerProbe.read(pid: Int(getpid()), identity: true)
    #expect(probe == .running(identity: ProcessIdentity.encode(startSeconds: born)))
}

/// The CLI never reads pid 1 or less as a run; `launchd` is always alive.
@Test func pidOneOrLessIsNeverAnOwner() {
    #expect(OwnerProbe.read(pid: 1, identity: true) == .gone)
    #expect(OwnerProbe.read(pid: 0, identity: false) == .gone)
    #expect(OwnerProbe.read(pid: -1, identity: false) == .gone)
}

/// A reused pid showed a finished run as live, and its Stop downed the
/// containers that run had left in the idle hold.
@Test func liveOnlyWhileThePidIsStillTheRecordedProcess() throws {
    let runs = try fixtureRuns()
    var run = try #require(runs.first)
    run.processIdentity = "v2:recorded"

    #expect(run.isLive(owner: .running(identity: "v2:recorded")))
    #expect(!run.isLive(owner: .running(identity: "v2:someone-else")))
    #expect(!run.isLive(owner: .gone))

    // An identity that cannot be read keeps a run, as in the CLI, unless the
    // sweep found its owner gone.
    #expect(run.isLive(owner: .running(identity: nil)))
    run.lifecycle = .lost(at: "2026-09-03T08:20:00.000Z")
    #expect(!run.isLive(owner: .running(identity: nil)))
    // The identity is the better evidence when it can be read.
    #expect(run.isLive(owner: .running(identity: "v2:recorded")))

    run.lifecycle = .released(at: "2026-09-03T09:30:00.000Z")
    #expect(!run.isLive(owner: .running(identity: "v2:recorded")))
}

/// The same rule as `runPhase` in `src/core/run-registry.ts`, and the
/// fixture's lifecycles decode to the phases the CLI's fixture test reads.
@Test func phaseFollowsTheCLIRule() throws {
    let runs = try fixtureRuns()
    #expect(runs.map(\.lifecycle) == [
        .live,
        .released(at: "2026-09-03T09:30:00.000Z"),
        .lost(at: "2026-09-03T08:20:00.000Z"),
    ])
    var run = try #require(runs.first)
    #expect(run.phase(alive: true) == .live)
    #expect(run.phase(alive: false) == .lost)
    run.lifecycle = .lost(at: "2026-09-03T08:20:00.000Z")
    #expect(run.phase(alive: true) == .live)
    run.lifecycle = .released(at: "2026-09-03T09:30:00.000Z")
    #expect(run.phase(alive: true) == .released)
}

/// Integrations record their fields under their own name; the Expo app is
/// the one offered a simulator button.
@Test func theExpoAppIsTheOneWithExpoIntegrationFields() throws {
    let run = try #require(try fixtureRuns().first)
    #expect(run.apps.filter(\.hasSimulator).map(\.name) == ["api"])
    #expect(run.apps.first(where: { $0.name == "api" })?.integrations?.expo?.scheme == "lullu")
}

@Test func aServiceWithAProblemIsNotReady() throws {
    let runs = try fixtureRuns()
    let run = try #require(runs.first)
    let mailpit = try #require(run.services.first(where: { $0.name == "mailpit" }))
    #expect(mailpit.problem?.state == "stopped")
    #expect(mailpit.state == .failed)
    #expect(run.services.first(where: { $0.name == "postgres" })?.state == .ready)
}

/// A run with containers only was yellow forever: its dot rolled up its apps.
@Test func aServicesOnlyRunIsGreenOnceItsServicesAreReady() throws {
    let runs = try fixtureRuns()
    var run = try #require(runs.last)
    run.apps = []
    #expect(run.state == .ready)

    run.services[0].problem = RunServiceProblem(state: "missing", detail: "postgres was removed")
    #expect(run.state == .failed)
}
