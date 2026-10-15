import Foundation
import Testing

@testable import BuncargoBar

private func runsFixture() throws -> Data {
    let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("fixtures/runs.v1.json")
    return try Data(contentsOf: path)
}

@Test func peersAreOnlineTailnetMachinesByName() throws {
    let status = """
        {"BackendState":"Running","Peer":{
          "a":{"HostName":"ubuntu","DNSName":"worker.tail1.ts.net.","TailscaleIPs":["100.70.1.2","fd7a:115c:a1e0::2"],"Online":true},
          "b":{"HostName":"phone","DNSName":"phone.tail1.ts.net.","TailscaleIPs":["100.70.1.3"],"Online":false}
        }}
        """
    #expect(try Tailnet.parsePeers(Data(status.utf8)) == [TailnetPeer(name: "worker", address: "100.70.1.2")])
    #expect(try Tailnet.parsePeers(Data(#"{"BackendState":"Stopped"}"#.utf8)).isEmpty)
}

@Test func remoteURLsPointAtThePeer() {
    let ip = "100.70.1.2"
    // A URL already meant for other machines is kept.
    #expect(
        Tailnet.reachableURL(named: "http://worker.tail1.ts.net:3000", loopback: "http://localhost:3000", at: ip)
            == "http://worker.tail1.ts.net:3000")
    // A named local host falls back to the loopback port on the peer.
    #expect(
        Tailnet.reachableURL(named: "https://web.app.localhost", loopback: "http://localhost:3000", at: ip)
            == "http://100.70.1.2:3000")
    #expect(
        Tailnet.reachableURL(
            named: nil, loopback: "postgresql://postgres:postgres@127.0.0.1:7432/db", at: ip)
            == "postgresql://postgres:postgres@100.70.1.2:7432/db")
    #expect(Tailnet.reachableURL(named: nil, loopback: nil, at: ip) == nil)
}

@Test @MainActor func storeShowsPeersWithRunsAndBacksOffSilentOnes() async throws {
    let runs = try JSONDecoder().decode(RunsFile.self, from: runsFixture()).runs
    let worker = TailnetPeer(name: "worker", address: "100.70.1.2")
    let phone = TailnetPeer(name: "phone", address: "100.70.1.3")
    let asked = Asked()
    let store = TailnetStore(
        deps: TailnetDependencies(
            peers: { [worker, phone] },
            fetch: { peer in
                await asked.add(peer.name)
                if peer == phone { throw TailnetError(message: "refused") }
                return runs
            }),
        startTimer: false)

    store.refresh()
    await store.waitForRefresh()
    #expect(store.machines.map(\.peer) == [worker])
    #expect(store.machines.first?.runs.count == runs.count)

    store.refresh()
    await store.waitForRefresh()
    #expect(await asked.names.filter { $0 == "phone" }.count == 1)

    store.refresh(force: true)
    await store.waitForRefresh()
    #expect(await asked.names.filter { $0 == "phone" }.count == 2)
}

private actor Asked {
    var names: [String] = []
    func add(_ name: String) { names.append(name) }
}
