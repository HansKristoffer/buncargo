import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isProcessAlive } from "./process/lifecycle";

/** Process birth identity survives exec but changes when an OS reuses a pid. */
export function readProcessIdentity(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	try {
		let birth: string;
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
			if (!start) return undefined;
			birth = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
		} else {
			birth = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
				encoding: "utf8",
				timeout: 1000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (!birth) return undefined;
		}
		return createHash("sha256").update(birth).digest("hex");
	} catch {
		return undefined;
	}
}

export function matchesProcessIdentity(
	pid: number,
	identity?: string,
): boolean {
	return (
		Number.isInteger(pid) &&
		pid > 1 &&
		isProcessAlive(pid) &&
		(identity === undefined || readProcessIdentity(pid) === identity)
	);
}
