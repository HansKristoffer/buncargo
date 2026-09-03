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
    var status: RunStatus?

    var id: String { name }
    var state: RunStatus { status ?? .starting }
    /// A dev server this run spawned, and can therefore stop on its own.
    var isOwned: Bool { pid != nil }
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

    var id: String { root }

    /// The main checkout is labelled by role, not by branch: it is the one
    /// everybody means by "the project". Worktrees are only recognisable by
    /// their directory name, which for agent worktrees is a hash.
    var title: String { worktree ?? "Main" }

    var primary: RunApp? {
        if let name = primaryApp, let match = apps.first(where: { $0.name == name }) {
            return match
        }
        return apps.first
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

enum RunRegistry {
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
        guard file.version == 1 else { return [] }
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
