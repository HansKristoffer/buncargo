import { createHash } from "node:crypto";

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/**
 * A digest of `vars` that is the same in every checkout and on every machine.
 *
 * Each checkout has its own ports, project name, workspace id and root, and a
 * machine its own addresses, so a cache keyed on the env itself gets one entry
 * per checkout and never hits in another (parallel CI jobs on one machine each
 * have their own). Those values become placeholders here: every IPv4 literal,
 * each of `ports` as a whole number, and each of `names` wherever it appears.
 * Longer names go first, so a root that contains the project name loses all of
 * itself.
 */
export function portableEnvFingerprint(
	vars: Readonly<Record<string, string>>,
	specific: { ports: readonly number[]; names: readonly string[] },
): string {
	const names = specific.names
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);
	const portable = (value: string) => {
		let out = value;
		for (const name of names) out = out.replaceAll(name, "<name>");
		out = out.replace(IPV4, "<ip>");
		for (const port of specific.ports)
			out = out.replace(new RegExp(`\\b${port}\\b`, "g"), "<port>");
		return out;
	};
	const entries = Object.entries(vars)
		.map(([key, value]) => [key, portable(value)] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
