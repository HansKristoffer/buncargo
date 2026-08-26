import type { BuncargoContainer } from "../types";
import { runDocker } from "./binary";

const LIST_ARGS = [
	"ps",
	"-a",
	"--filter",
	"label=buncargo.project",
	"--format",
	'{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "buncargo.project"}}\t{{.Label "buncargo.root"}}\t{{.Label "buncargo.worktree"}}\t{{.Label "buncargo.service"}}',
];

export function parseDockerContainerLine(
	line: string,
): BuncargoContainer | null {
	const [id, name, status, ports, project, root, worktree, service] =
		line.split("\t");
	if (!id || !project) return null;
	return {
		id,
		name: name ?? id,
		status: status ?? "",
		ports: ports ?? "",
		project,
		root: root ?? "",
		worktree: worktree ?? "",
		service: service ?? "",
		runtime: "docker",
	};
}

/** Every container (running or not) labeled by buncargo on this machine. */
export function listDockerBuncargoContainers(
	binary?: string,
): BuncargoContainer[] {
	const result = runDocker(binary, LIST_ARGS);
	if (!result.ok) {
		throw new Error(result.stderr.trim() || "docker ps failed");
	}
	return result.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const parsed = parseDockerContainerLine(line);
			return parsed ? [parsed] : [];
		});
}

export function stopDockerContainersByIds(
	ids: string[],
	binary?: string,
): void {
	if (ids.length === 0) return;
	const result = runDocker(binary, ["stop", ...ids], { inherit: true });
	if (!result.ok) {
		throw new Error(
			result.stderr.trim() || `docker stop failed for ${ids.join(", ")}`,
		);
	}
}
