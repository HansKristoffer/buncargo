import type { PortContainerOwner } from "../types";
import { runDocker } from "./binary";

export function parseDockerPublishedPort(
	portsField: string,
	port: number,
): boolean {
	const pattern = new RegExp(
		`(?:^|,|\\s)(?:\\[::\\]|0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\*):${port}->`,
	);
	return pattern.test(portsField) || new RegExp(`:${port}->`).test(portsField);
}

export function findDockerContainerOnPort(
	port: number,
	binary?: string,
): PortContainerOwner | undefined {
	const result = runDocker(binary, [
		"ps",
		"--format",
		'{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}',
	]);
	if (!result.ok) return undefined;

	for (const line of result.stdout.trim().split("\n")) {
		if (!line) continue;
		const [id, name, portsField, composeProject] = line.split("\t");
		if (!id || !portsField || !parseDockerPublishedPort(portsField, port)) {
			continue;
		}
		return {
			id,
			name: name ?? id,
			composeProject: composeProject || undefined,
		};
	}
	return undefined;
}
