import { spawnSync } from "node:child_process";

/** Open a URL in the default browser. Returns false when nothing opened it. */
export function openUrl(url: string): boolean {
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	return spawnSync(opener, [url], { stdio: "ignore" }).status === 0;
}
