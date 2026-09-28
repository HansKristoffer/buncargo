import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Shopify CLI as buncargo drives it: which binary, which version, and
 * whether it is logged in, all without starting anything interactive.
 */

/** Versions the integration is tested against: 3.90 and newer 3.x, and 4.x. */
const TESTED_SHOPIFY_CLI = {
	min: [3, 90, 0],
	below: [5, 0, 0],
} as const;

/** The project's own CLI first, so every checkout runs its pinned version. */
export function resolveShopifyBin(root: string): string {
	const local = join(root, "node_modules", ".bin", "shopify");
	return existsSync(local) ? local : "shopify";
}

export function parseVersion(
	text: string,
): [number, number, number] | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match
		? [Number(match[1]), Number(match[2]), Number(match[3])]
		: undefined;
}

function compare(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < 3; index++) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export function isTestedShopifyVersion(version: readonly number[]): boolean {
	return (
		compare(version, TESTED_SHOPIFY_CLI.min) >= 0 &&
		compare(version, TESTED_SHOPIFY_CLI.below) < 0
	);
}

/** `shopify version`, or undefined when the binary cannot run. */
export function shopifyVersion(bin: string, cwd: string): string | undefined {
	try {
		const result = Bun.spawnSync([bin, "version"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, SHOPIFY_CLI_NO_ANALYTICS: "1" },
		});
		if (result.exitCode !== 0) return undefined;
		return parseVersion(result.stdout.toString())?.join(".");
	} catch {
		return undefined;
	}
}

/** Where `@shopify/cli-kit` keeps its `conf` store, per platform. */
function shopifySessionFile(home = homedir()): string {
	return process.platform === "darwin"
		? join(
				home,
				"Library",
				"Preferences",
				"shopify-cli-kit-nodejs",
				"config.json",
			)
		: join(
				process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
				"shopify-cli-kit-nodejs",
				"config.json",
			);
}

/**
 * Whether a Partners/account session is stored. The CLI refreshes an expired
 * token itself; a missing one needs `shopify auth login`, which is browser
 * interactive and cannot happen inside a dev run's TUI without confusion.
 */
export function isShopifyLoggedIn(file = shopifySessionFile()): boolean {
	try {
		const store = JSON.parse(readFileSync(file, "utf8")) as {
			sessionStore?: unknown;
			currentSessionId?: unknown;
		};
		return (
			typeof store.sessionStore === "string" &&
			store.sessionStore.length > 2 &&
			typeof store.currentSessionId === "string" &&
			store.currentSessionId.length > 0
		);
	} catch {
		return false;
	}
}

/** Whether `.shopify/project.json` records this app (linked, dev store chosen). */
export function isShopifyAppLinked(root: string, clientId: string): boolean {
	try {
		const project = JSON.parse(
			readFileSync(join(root, ".shopify", "project.json"), "utf8"),
		) as Record<string, unknown>;
		return typeof project[clientId] === "object" && project[clientId] !== null;
	} catch {
		return false;
	}
}
