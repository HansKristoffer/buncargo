import type {
	ComposeProjectResource,
	ComposeProjectResourceKind,
	ComposeProjectResources,
} from "../container-runtime/types";
import { runDocker, runDockerAsync } from "./binary";

/**
 * Listing and removing Compose projects' resources, for
 * `buncargo prune --project`.
 *
 * By Compose's own project label rather than buncargo's: a stack's volumes
 * carry no buncargo label (see `volumes.ts`), and a container in a project
 * that lacks one is exactly what the prune has to notice and leave alone.
 */

const PROJECT = '{{.Label "com.docker.compose.project"}}';
const FILTER = ["--filter", "label=com.docker.compose.project"];
const STOPPED = new Set(["exited", "created", "dead"]);

function rows(args: string[], binary?: string): string[][] {
	const result = runDocker(binary, args, { timeoutMs: 30_000 });
	if (!result.ok)
		throw new Error(
			`docker ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
		);
	return result.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
}

function resources(
	command: "volume" | "network",
	binary?: string,
): ComposeProjectResource[] {
	return rows(
		[command, "ls", ...FILTER, "--format", `{{.Name}}\t${PROJECT}`],
		binary,
	).flatMap(([name, project]) => (name && project ? [{ name, project }] : []));
}

export function listDockerComposeProjectResources(
	binary?: string,
): ComposeProjectResources {
	return {
		containers: rows(
			[
				"ps",
				"-a",
				...FILTER,
				"--format",
				`{{.ID}}\t${PROJECT}\t{{.State}}\t{{.Label "buncargo.root"}}`,
			],
			binary,
		).flatMap(([id, project, state = "", root = ""]) =>
			id && project
				? [{ id, project, running: !STOPPED.has(state.trim()), root }]
				: [],
		),
		volumes: resources("volume", binary),
		networks: resources("network", binary),
	};
}

const REMOVE: Record<ComposeProjectResourceKind, string[]> = {
	container: ["rm"],
	volume: ["volume", "rm"],
	network: ["network", "rm"],
};

export async function removeDockerComposeProjectResource(
	kind: ComposeProjectResourceKind,
	name: string,
	binary?: string,
): Promise<string | undefined> {
	const result = await runDockerAsync(binary, [...REMOVE[kind], name], {
		timeoutMs: 30_000,
	});
	if (result.ok) return undefined;
	return (
		result.stderr.trim() ||
		`docker ${REMOVE[kind].join(" ")} exited ${result.exitCode}`
	);
}
