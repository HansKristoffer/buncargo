import { execSync } from "node:child_process";
import { isDockerDaemonRunning } from "../../../docker";

export interface BuncargoContainer {
	id: string;
	name: string;
	status: string;
	ports: string;
	project: string;
	root: string;
	worktree: string;
	service: string;
}

function parseContainerLine(line: string): BuncargoContainer | null {
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
	};
}

/**
 * Every container (running or not) labeled by buncargo on this machine.
 */
export function listBuncargoContainers(): BuncargoContainer[] {
	if (!isDockerDaemonRunning()) {
		throw new Error("Docker is not running. Start Docker and try again.");
	}
	try {
		const output = execSync(
			'docker ps -a --filter label=buncargo.project --format "{{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Label \\"buncargo.project\\"}}\\t{{.Label \\"buncargo.root\\"}}\\t{{.Label \\"buncargo.worktree\\"}}\\t{{.Label \\"buncargo.service\\"}}"',
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		return output
			.trim()
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				const parsed = parseContainerLine(line);
				return parsed ? [parsed] : [];
			});
	} catch (error) {
		throw new Error(
			`Could not list buncargo containers: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function isContainerUp(container: BuncargoContainer): boolean {
	return container.status.toLowerCase().includes("up");
}
