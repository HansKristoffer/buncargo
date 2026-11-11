import CryptoKit
import Darwin
import Foundation

/// The `~/.buncargo/runs.json` contract, version 2.
///
/// Written by `buncargo dev` and read here. Every field the CLI marks optional
/// is optional here too: an app decodes a registry written by an older or newer
/// CLI rather than showing nothing, because the two version independently and
/// a mismatch must degrade, not blank the menu.
enum RunStatus: String, Codable {
    case starting, ready, reused, failed, stopped

    /// A status this build does not know, from a newer CLI, reads as
    /// `starting`, as a missing one does: not ready, and not a failure the
    /// app cannot explain.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RunStatus(rawValue: raw) ?? .starting
    }

    /// Rendered as a filled dot. `reused` counts: something is serving it.
    var isUp: Bool { self == .ready || self == .reused }
}

struct RunApp: Codable, Identifiable, Hashable {
    let name: String
    let port: Int?
    var pid: Int?
    var attached: Bool?
    let url: String?
    let loopbackUrl: String?
    var publicUrl: String?
    /// What "open" opens, decided by the CLI (`preferredAppUrl`); absent from older runs.
    var openUrl: String?
    var hostname: String?
    /// What each integration recorded about the app, by integration name.
    var integrations: RunIntegrations?
    /// The exclusive lease this app holds, e.g. `shopify-app:<client_id>`.
    var exclusive: String?
    var status: RunStatus?

    var id: String { name }
    var state: RunStatus { status ?? .starting }
    /// A dev server this run spawned, and can therefore stop on its own.
    var isOwned: Bool { pid != nil }
    var hasSimulator: Bool { integrations?.expo != nil && state != .stopped }

    /// The CLI's choice when it recorded one, the old rule otherwise.
    func preferredURL(hostsActive: Bool) -> String {
        openUrl ?? Actions.preferredURL(named: url, loopback: loopbackUrl, hostsActive: hostsActive)
    }
}

/// The integrations this build knows; any other key is ignored.
struct RunIntegrations: Codable, Hashable {
    /// Present on Expo apps. Its fields belong to the CLI; here it only means
    /// "offer the simulator button".
    var expo: RunExpo?
}

struct RunExpo: Codable, Hashable {
    var scheme: String?
    var bundleId: String?
    var simulator: String?
}

struct RunContainer: Codable, Hashable {
    let runtime: String
    let name: String
}

/// Set by the run when a container stopped, was removed or turned unhealthy
/// under it; cleared when it recovers. A field rather than a status, so the
/// status stays what the run last set.
struct RunServiceProblem: Codable, Hashable {
    let state: String
    let detail: String
    var since: String?
}

struct RunService: Codable, Identifiable, Hashable {
    let name: String
    var preset: String?
    let port: Int?
    let url: String?
    let loopbackUrl: String?
    var publicUrl: String?
    var hostname: String?
    var tablePlusUrl: String?
    var container: RunContainer?
    var status: RunStatus?
    var problem: RunServiceProblem?

    var id: String { name }
    /// A service with a problem is not ready, whatever its status says: the
    /// CLI's `status` calls such a run degraded.
    var state: RunStatus { problem != nil ? .failed : (status ?? .starting) }
    /// Only a browser-openable service gets an "open" action.
    var isHTTP: Bool { url?.hasPrefix("http://") == true || url?.hasPrefix("https://") == true }
}

/// A labelled value from an integration, e.g. "Shopify preview".
struct RunDetail: Codable, Identifiable, Hashable {
    let label: String
    let value: String

    var id: String { label }
    var isURL: Bool { value.hasPrefix("http://") || value.hasPrefix("https://") }
}

/// A config task, run from the menu with `buncargo run <name>`.
struct RunTask: Codable, Identifiable, Hashable {
    let name: String
    var description: String?

    var id: String { name }
}

struct RunHosts: Codable, Hashable {
    let active: Bool
    let tld: String
}

struct RunCLI: Codable, Hashable {
    let program: String
    var script: String?
}

/// Where a run is in its life, as its owner and the CLI's sweep recorded it
/// (`lifecycle` in `src/core/run-registry.ts`).
enum RunLifecycle: Codable, Hashable {
    /// The owner has not said it finished; it may have crashed since.
    case live
    /// The owner exited on purpose; only its containers remain, in the hold.
    case released(at: String)
    /// The sweep found the owner gone without releasing.
    case lost(at: String)

    private enum CodingKeys: String, CodingKey { case state, at }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let state = try container.decode(String.self, forKey: .state)
        switch state {
        case "live":
            self = .live
        case "released":
            self = try .released(at: container.decode(String.self, forKey: .at))
        case "lost":
            self = try .lost(at: container.decode(String.self, forKey: .at))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .state, in: container, debugDescription: "Unknown lifecycle state \(state)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .live:
            try container.encode("live", forKey: .state)
        case .released(let at):
            try container.encode("released", forKey: .state)
            try container.encode(at, forKey: .at)
        case .lost(let at):
            try container.encode("lost", forKey: .state)
            try container.encode(at, forKey: .at)
        }
    }
}

/// `runPhase` in `src/core/run-registry.ts`: every reader of the registry
/// decides with the same rule.
enum RunPhase: Equatable {
    case live, released, lost
}

struct Run: Codable, Identifiable, Hashable {
    var sessionId: String?
    let projectPrefix: String
    let projectName: String
    let root: String
    var worktree: String?
    var branch: String?
    let pid: Int
    let startedAt: String
    let updatedAt: String
    /// A released run is kept so the CLI's sweep knows its containers may
    /// still be reused, and for how long. Nothing here should show it: the
    /// run is over. Checked rather than relying on the pid being dead,
    /// because these entries outlive their process and a reused pid would
    /// otherwise put a finished run back in the menu.
    var lifecycle: RunLifecycle
    /// The owner's birth identity (`v2:` + SHA-256 of its start time), which
    /// tells the process that published this entry from a later one that
    /// reused its pid.
    var processIdentity: String?
    var primaryApp: String?
    var hosts: RunHosts?
    var cli: RunCLI?
    var apps: [RunApp]
    var services: [RunService]
    /// Absent from registries written before tasks existed.
    var tasks: [RunTask]?
    /// Integration rows; absent from registries that predate integrations.
    var details: [RunDetail]?

    var id: String { sessionId ?? root }

    /// The branch is the readable name; agent worktree directories are hashes.
    var title: String { branch ?? worktree ?? "Main" }

    /// The worktree directory, shown under the branch so a hash is still findable.
    var subtitle: String? { branch != nil ? worktree : nil }

    var primary: RunApp? {
        if let name = primaryApp, let match = apps.first(where: { $0.name == name && $0.url != nil }) {
            return match
        }
        return apps.first { $0.url != nil }
    }

    /// The Expo app a phone button on the run row opens, if there is exactly one live.
    var simulatorApp: RunApp? {
        let live = apps.filter(\.hasSimulator)
        return live.count == 1 ? live.first : nil
    }

    /// The run's dot: its apps and its services together, so a run with
    /// containers only is green once they are ready, not yellow for good.
    var state: RunStatus { .rollup(apps.map(\.state) + services.map(\.state)) }

    /// Is this a run the menu should show?
    ///
    /// The CLI's rule (`runPhase`): live while not released and the pid is
    /// still the process that published the entry. A pid alone is not enough:
    /// a reused one showed a finished run as live, and its Stop then took down
    /// the containers it had left in the idle hold. The registry is pruned by
    /// the CLI, but only when a CLI runs; between runs this is the only thing
    /// that retires a crashed run from the menu.
    var isAlive: Bool {
        if case .released = lifecycle { return false }
        return isLive(owner: OwnerProbe.read(pid: pid, identity: processIdentity != nil))
    }

    /// ``isAlive`` for an owner already probed. Pure, so it is tested
    /// without processes.
    func isLive(owner: OwnerProbe) -> Bool {
        phase(alive: ownerIsAlive(owner)) == .live
    }

    /// `runPhase(entry, alive)`: a released run is never live whatever its
    /// pid says, and a run the sweep stamped lost is live again once its
    /// owner reads as itself.
    func phase(alive: Bool) -> RunPhase {
        if case .released = lifecycle { return .released }
        return alive ? .live : .lost
    }

    /// Whether the probed owner is the process that published this entry.
    ///
    /// Like the CLI, an identity that cannot be read does not make a live run
    /// dead, unless the sweep has found the owner gone: then this reader has
    /// no better evidence than that.
    func ownerIsAlive(_ owner: OwnerProbe) -> Bool {
        switch owner {
        case .gone:
            return false
        case .running(let identity):
            guard let recorded = processIdentity, let identity else {
                if case .lost = lifecycle { return false }
                return true
            }
            return identity == recorded
        }
    }
}

/// What the system says about a recorded pid.
enum OwnerProbe: Equatable {
    case gone
    /// Running, with its birth identity, or `nil` when it was not asked for
    /// or could not be read.
    case running(identity: String?)

    /// Signal 0 checks for existence without delivering anything; `EPERM` is
    /// another user's process, which exists.
    ///
    /// A pid of 1 or less is never a run, as in the CLI (`livePids`): `launchd`
    /// is always alive, and `kill` treats 0 and negative pids as groups.
    static func read(pid: Int, identity wanted: Bool) -> OwnerProbe {
        guard pid > 1, pid <= Int(Int32.max) else { return .gone }
        guard kill(pid_t(pid), 0) == 0 || errno == EPERM else { return .gone }
        guard wanted, let born = ProcessIdentity.startSeconds(pid: pid_t(pid)) else {
            return .running(identity: nil)
        }
        return .running(identity: ProcessIdentity.encode(startSeconds: born))
    }
}

/// A process's birth identity, encoded exactly as `src/core/process-identity.ts`
/// encodes it on macOS: `v2:` and the SHA-256 hex of what `ps -o lstart=`
/// prints in the C locale and UTC (`strftime` `%c`, "Thu Jan  1 00:00:00 1970").
/// `ps` reads the same start time from the same `sysctl`.
enum ProcessIdentity {
    /// The process's start time in whole seconds, from `KERN_PROC_PID`.
    static func startSeconds(pid: pid_t) -> Int? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0 else {
            return nil
        }
        return Int(info.kp_proc.p_un.__p_starttime.tv_sec)
    }

    static func encode(startSeconds: Int) -> String {
        let digest = SHA256.hash(data: Data(lstart(startSeconds).utf8))
        return "v2:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    /// `%a %b %e %H:%M:%S %Y` in UTC, spelled out rather than left to a
    /// locale: the C locale's `%c`, which is what the CLI hashes.
    static func lstart(_ seconds: Int) -> String {
        var time = time_t(seconds)
        var parts = tm()
        gmtime_r(&time, &parts)
        let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        func twoDigits(_ value: Int32) -> String { value < 10 ? "0\(value)" : "\(value)" }
        let day = parts.tm_mday < 10 ? " \(parts.tm_mday)" : "\(parts.tm_mday)"
        let clock = "\(twoDigits(parts.tm_hour)):\(twoDigits(parts.tm_min)):\(twoDigits(parts.tm_sec))"
        return "\(weekdays[Int(parts.tm_wday)]) \(months[Int(parts.tm_mon)]) \(day) \(clock) \(parts.tm_year + 1900)"
    }
}

struct RunsFile: Decodable {
    let version: Int
    let runs: [Run]

    private enum CodingKeys: String, CodingKey { case version, runs }

    /// Each run decodes on its own, and one this build cannot read is
    /// dropped, as the CLI drops it: decoded as one array, a single entry
    /// from a newer CLI emptied the menu.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        var entries = try container.nestedUnkeyedContainer(forKey: .runs)
        var runs: [Run] = []
        while !entries.isAtEnd {
            if let run = try entries.decode(Skippable<Run>.self).value { runs.append(run) }
        }
        self.runs = runs
    }
}

/// Decodes `T` or nothing, never throwing, so an unkeyed container moves
/// past an element that is not a `T`.
private struct Skippable<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

/// The app cannot read this registry, and no amount of retrying will change
/// that: the CLI writing it is another version than this build reads.
///
/// Distinct from a decode failure, which is usually a half-written file and
/// fixes itself on the next read. A newer registry needs a new app; an older
/// one, served by another machine's CLI, needs that CLI updated.
struct UnsupportedRegistryVersion: LocalizedError {
    let found: Int
    let supported: Int

    var errorDescription: String? {
        if found < supported {
            return "This BuncargoBar reads runs.json v\(supported), but that buncargo writes v\(found). Update buncargo there."
        }
        return "This BuncargoBar reads runs.json v\(supported), but buncargo now writes v\(found)."
    }
}

enum RunRegistry {
    /// The `runs.json` schema this build decodes.
    ///
    /// `scripts/package.sh` stamps the same number into `Info.plist` as
    /// `BuncargoRegistryVersion` — read from `fixtures/runs.v2.json`, which is
    /// also what `--status` decodes in CI, so a bump that misses one of the
    /// three fails the build rather than shipping.
    static let supportedVersion = 2

    static var url: URL {
        stateDirectory.appendingPathComponent("runs.json")
    }

    /// `~/.buncargo`, resolved the way the CLI resolves it.
    ///
    /// `HOME` first, because `homeDirectoryForCurrentUser` reads the user
    /// record and ignores the environment — so a harness pointing `HOME` at a
    /// fixture directory would silently be handed the real registry instead.
    /// That is exactly what `--status` in CI is for.
    static var stateDirectory: URL {
        if let home = ProcessInfo.processInfo.environment["HOME"], !home.isEmpty {
            return URL(fileURLWithPath: home).appendingPathComponent(".buncargo")
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".buncargo")
    }

    /// Live runs, grouped and ordered for display.
    ///
    /// A missing file is the normal "nothing is running" state, not an error:
    /// the CLI deletes it once the last run exits. So is a file an older CLI
    /// wrote: the first newer CLI to write replaces it, and its runs are ones
    /// this build cannot read.
    static func load() throws -> [Run] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let file = try JSONDecoder().decode(RunsFile.self, from: data)
        if file.version < supportedVersion { return [] }
        guard file.version == supportedVersion else {
            // Not an empty list: an app that silently shows nothing reads as a
            // broken `buncargo dev`, and the user would debug the wrong thing.
            throw UnsupportedRegistryVersion(
                found: file.version,
                supported: supportedVersion
            )
        }
        return file.runs.filter { $0.isAlive }
    }
}

/// One project's runs, main checkout first.
struct ProjectGroup: Identifiable {
    let name: String
    let runs: [Run]
    var id: String { name }
}

func groupByProject(_ runs: [Run]) -> [ProjectGroup] {
    var order: [String] = []
    var byProject: [String: [Run]] = [:]
    for run in runs {
        let key = run.projectPrefix.isEmpty ? run.projectName : run.projectPrefix
        if byProject[key] == nil { order.append(key) }
        byProject[key, default: []].append(run)
    }
    return order.map { key in
        let sorted = (byProject[key] ?? []).sorted { lhs, rhs in
            if (lhs.worktree == nil) != (rhs.worktree == nil) {
                return lhs.worktree == nil
            }
            return lhs.startedAt < rhs.startedAt
        }
        return ProjectGroup(name: key, runs: sorted)
    }
}
