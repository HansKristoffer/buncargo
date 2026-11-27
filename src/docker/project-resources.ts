import {
	isContainerLive,
	parseContainerState,
} from "../container-runtime/container-state";
import type {
	ComposeProjectResource,
	ComposeProjectResourceKind,
	ComposeProjectResources,
} from "../container-runtime/types";
import { runDockerAsync } from "./binary";

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

async function rowsAsync(args: string[], binary?: string): Promise<string[][]> {
	const result = await runDockerAsync(binary, args, { timeoutMs: 30_000 });
	if (!result.ok) {
		const reason = result.stderr.trim() || `exit ${result.exitCode}`;
		throw new Error(`docker ${args[0]} failed: ${reason}`);
	}

	return result.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
}

async function resourcesAsync(
	command: "volume" | "network",
	binary?: string,
): Promise<ComposeProjectResource[]> {
	return (
		await rowsAsync(
			[command, "ls", ...FILTER, "--format", `{{.Name}}\t${PROJECT}`],
			binary,
		)
	).flatMap(([name, project]) => (name && project ? [{ name, project }] : []));
}

export async function listDockerComposeProjectResources(
	binary?: string,
): Promise<ComposeProjectResources> {
	const [containerRows, volumes, networks] = await Promise.all([
		rowsAsync(
			[
				"ps",
				"-a",
				...FILTER,
				"--format",
				`{{.ID}}\t${PROJECT}\t{{.State}}\t{{.Label "buncargo.root"}}`,
			],
			binary,
		),
		resourcesAsync("volume", binary),
		resourcesAsync("network", binary),
	]);
	return {
		containers: containerRows.flatMap(([id, project, state = "", root = ""]) =>
			id && project
				? [
						{
							id,
							project,
							running: isContainerLive(parseContainerState(state)),
							root,
						},
					]
				: [],
		),
		volumes,
		networks,
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
