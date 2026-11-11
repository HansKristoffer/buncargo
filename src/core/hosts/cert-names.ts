import { join } from "node:path";
import { isString } from "hanzio";
import { checkoutDeleted } from "../checkout-presence";
import { arrayOf, type Guard, object } from "../json-shape";
import { defineListRegistry } from "../registry-file";
import { chownToInvokingUser, getStateDir } from "../state-paths";

/**
 * The certificate names each project wants, remembered across runs.
 *
 * One leaf serves every project on the machine, and it used to be minted from
 * whatever was in the route registry at that moment. So a project stopping
 * dropped its names, and starting it again reminted — which rebinds the daemon
 * and drops every proxied websocket, including other projects' HMR sockets.
 * Two projects alternating could remint on every single run.
 *
 * Keyed by repo root, which is also how an entry is retired: a worktree that
 * has been deleted is gone from disk, and its names go with it. That is the
 * one signal available — a route disappears whenever a run ends, and cannot
 * distinguish "stopped" from "removed".
 */

const REGISTRY_VERSION = 1;

/**
 * How many roots to remember.
 *
 * Generous: entries are small and are already pruned by directory existence.
 * The cap only bounds a machine that creates and deletes checkouts faster than
 * anything reads this file.
 */
const MAX_ROOTS = 200;

export interface CertNameEntry {
	/** Repo root the names belong to. */
	root: string;
	/** Hostnames and wildcards, as `certificateHostnames` produced them. */
	names: string[];
	updatedAt: string;
}

const CERT_NAMES_FILENAME = "cert-names.json";

export function getCertNamesPath(): string {
	return join(getStateDir(), CERT_NAMES_FILENAME);
}

const isCertNameEntry: Guard<CertNameEntry> = object({
	root: isString,
	names: arrayOf(isString),
	updatedAt: isString,
});

const registry = defineListRegistry<CertNameEntry>({
	version: REGISTRY_VERSION,
	key: "projects",
	isEntry: isCertNameEntry,
	afterWrite: chownToInvokingUser,
});

function byNewestFirst(a: CertNameEntry, b: CertNameEntry): number {
	return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/** Drop entries whose checkout is gone, and cap what is left. */
export function pruneCertNameEntries(
	entries: CertNameEntry[],
): CertNameEntry[] {
	return entries
		.filter((entry) => !checkoutDeleted(entry.root))
		.sort(byNewestFirst)
		.slice(0, MAX_ROOTS);
}

/**
 * Record this project's names and return every name the certificate should
 * carry, across all projects still on disk.
 *
 * Callers hold the certificate lock, so this does not take one of its own.
 */
export async function rememberCertNames(input: {
	root?: string;
	names: string[];
}): Promise<string[]> {
	const path = getCertNamesPath();
	const stored = await registry.read(path);
	const live = pruneCertNameEntries(stored);

	// An empty name list is never a recording: a caller that only wants the
	// union must not be able to erase a project's coverage by omission.
	// An entry is retired only when its checkout is gone from disk
	// (`pruneCertNameEntries`); `hosts uninstall` removes the whole file.
	const { root } = input;
	const names = [...new Set(input.names)].sort();
	const current = live.find((entry) => entry.root === root);
	const changed =
		root && names.length > 0 && current?.names.join(",") !== names.join(",");
	const next = changed
		? [
				...live.filter((entry) => entry.root !== root),
				{ root, names, updatedAt: new Date().toISOString() },
			]
		: live;

	// Only when something actually changed: this runs on every dev start, and
	// the daemon watches this directory. Pruning only ever removes entries.
	if (changed || live.length !== stored.length) {
		await registry.write(path, next);
	}

	return [...new Set(next.flatMap((entry) => entry.names))].sort();
}
