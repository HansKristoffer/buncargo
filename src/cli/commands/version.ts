import { buncargoVersion } from "../../core/version";

export function showVersion(): void {
	console.log(`buncargo v${buncargoVersion() ?? "of unknown version"}`);
}
