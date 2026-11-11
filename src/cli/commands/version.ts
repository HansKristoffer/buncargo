import { buncargoVersion } from "../../core/version";
import { BASE_EXITS, defineCommand } from "../command-spec";

export function showVersion(): void {
	console.log(`buncargo v${buncargoVersion() ?? "of unknown version"}`);
}

export const versionCommand = defineCommand({
	spec: { name: "version", summary: "Show version", flags: {} },
	exits: BASE_EXITS,
	run: () => {
		showVersion();
		return 0;
	},
});
