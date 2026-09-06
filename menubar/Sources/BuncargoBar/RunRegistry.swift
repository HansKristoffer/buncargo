import Foundation

/// The `~/.buncargo/runs.json` contract, version 1.
///
/// Written by `buncargo dev` and read here. Every field the CLI marks optional
/// is optional here too: an app decodes a registry written by an older or newer
/// CLI rather than showing nothing, because the two version independently and
/// a mismatch must degrade, not blank the menu.
enum RunStatus: String, Codable {
    case starting, ready, reused, failed, stopped

    /// Rendered as a filled dot. `reused` counts: something is serving it.
    var isUp: Bool { self == .ready || self == .reused }
}

struct RunApp: Codable, Identifiable, Hashable {
    let name: String
    let port: Int
    var pid: Int?
    var attached: Bool?
    let url: String
    let loopbackUrl: String
    var publicUrl: String?
    var hostname: String?
    /// Present on Expo apps. Its fields belong to the CLI; here it only means
    /// "offer the simulator button".
    var expo: RunExpo?
    var status: RunStatus?

    var id: String { name }
    var state: RunStatus { status ?? .starting }
    /// A dev server this run spawned, and can therefore stop on its own.
    var isOwned: Bool { pid != nil }
    var hasSimulator: Bool { expo != nil && state != .stopped }
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

struct RunService: Codable, Identifiable, Hashable {
    let name: String
    var preset: String?
    let port: Int
    let url: String
    let loopbackUrl: String
    var publicUrl: String?
    var hostname: String?
    var tablePlusUrl: String?
    var container: RunContainer?
    var status: RunStatus?

    var id: String { name }
    var state: RunStatus { status ?? .starting }
    /// Only a browser-openable service gets an "open" action.
    var isHTTP: Bool { url.hasPrefix("http://") || url.hasPrefix("https://") }
}

struct RunHosts: Codable, Hashable {
    let active: Bool
    let tld: String
}

struct RunCLI: Codable, Hashable {
    let program: String
    var script: String?
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
    var primaryApp: String?
    var hosts: RunHosts?
    var cli: RunCLI?
    var apps: [RunApp]
    var services: [RunService]

    var id: String { sessionId ?? root }

    /// The branch is the readable name; agent worktree directories are hashes.
    var title: String { branch ?? worktree ?? "Main" }

    /// The worktree directory, shown under the branch so a hash is still findable.
    var subtitle: String? { branch != nil ? worktree : nil }

    var primary: RunApp? {
        if let name = primaryApp, let match = apps.first(where: { $0.name == name }) {
            return match
        }
        return apps.first
    }

    /// The Expo app a phone button on the run row opens, if there is exactly one live.
    var simulatorApp: RunApp? {
        let live = apps.filter(\.hasSimulator)
        return live.count == 1 ? live.first : nil
    }

    /// Is the process that published this entry still alive?
    ///
    /// Signal 0 checks for existence without delivering anything. The registry
    /// is pruned by the CLI, but only when a CLI runs; between runs this is the
    /// only thing that retires a crashed run from the menu.
    var isAlive: Bool { kill(pid_t(pid), 0) == 0 || errno == EPERM }
}

private struct RunsFile: Codable {
    let version: Int
    let runs: [Run]
}

/// The app cannot read this registry, and no amount of retrying will change
/// that: the CLI writing it is newer than this build.
///
/// Distinct from a decode failure, which is usually a half-written file and
/// fixes itself on the next read. This one needs a new app.
struct UnsupportedRegistryVersion: LocalizedError {
    let found: Int
    let supported: Int

    var errorDescription: String? {
        "This BuncargoBar reads runs.json v\(supported), but buncargo now writes v\(found)."
    }
}

enum RunRegistry {
    /// The `runs.json` schema this build decodes.
    ///
    /// `scripts/package.sh` stamps the same number into `Info.plist` as
    /// `BuncargoRegistryVersion` — read from `fixtures/runs.v1.json`, which is
    /// also what `--status` decodes in CI, so a bump that misses one of the
    /// three fails the build rather than shipping.
    static let supportedVersion = 1

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
    /// the CLI deletes it once the last run exits.
    static func load() throws -> [Run] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let file = try JSONDecoder().decode(RunsFile.self, from: data)
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
