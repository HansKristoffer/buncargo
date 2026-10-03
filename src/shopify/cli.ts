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
export function shopifySessionFile(
	home = homedir(),
	env: Record<string, string | undefined> = process.env,
): string {
	return process.platform === "darwin"
		? join(
				home,
				"Library",
				"Preferences",
				"shopify-cli-kit-nodejs",
				"config.json",
			)
		: join(
				env.XDG_CONFIG_HOME ?? join(home, ".config"),
				"shopify-cli-kit-nodejs",
				"config.json",
			);
}

export interface ShopifySession {
	/** When the identity token expires; the CLI refreshes it when it can. */
	expiresAt?: Date;
}

interface StoredIdentity {
	userId?: unknown;
	expiresAt?: unknown;
}

/** Every `{ identity }` in the session store, whichever nesting this CLI version uses. */
function identities(value: unknown, depth = 0): StoredIdentity[] {
	if (!value || typeof value !== "object" || depth > 3) return [];
	const record = value as Record<string, unknown>;
	if (record.identity && typeof record.identity === "object")
		return [record.identity as StoredIdentity];
	return Object.values(record).flatMap((entry) => identities(entry, depth + 1));
}

/**
 * The stored Partners/account session, or undefined without one.
 *
 * Only what the file says: a session can be present and still rejected (a
 * revoked refresh token). The preflight runs an authenticated command to
 * find out, because a refresh needs the network and maybe a browser.
 */
export function readShopifySession(
	file = shopifySessionFile(),
): ShopifySession | undefined {
	try {
		const store = JSON.parse(readFileSync(file, "utf8")) as {
			sessionStore?: unknown;
			currentSessionId?: unknown;
		};
		if (
			typeof store.sessionStore !== "string" ||
			store.sessionStore.length <= 2 ||
			typeof store.currentSessionId !== "string" ||
			store.currentSessionId.length === 0
		)
			return undefined;
		let found: StoredIdentity[] = [];
		try {
			found = identities(JSON.parse(store.sessionStore));
		} catch {
			// An unreadable store is still a session: the CLI decides.
		}
		const identity =
			found.find((entry) => entry.userId === store.currentSessionId) ??
			found[0];
		const expiresAt =
			typeof identity?.expiresAt === "string"
				? new Date(identity.expiresAt)
				: undefined;
		return {
			expiresAt:
				expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : undefined,
		};
	} catch {
		return undefined;
	}
}

/** A minute of slack: a token that expires mid-start is as good as expired. */
export function isShopifySessionExpired(
	session: ShopifySession,
	now = Date.now(),
): boolean {
	return (
		session.expiresAt !== undefined &&
		session.expiresAt.getTime() <= now + 60_000
	);
}

/** Whether a Partners/account session is stored at all. */
export function isShopifyLoggedIn(file = shopifySessionFile()): boolean {
	return readShopifySession(file) !== undefined;
}

/** Whether `.shopify/project.json` records this app: how CLIs before 4.8 linked. */
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

/**
 * `shopify app info --config <name> --json`: a cheap authenticated command.
 * It succeeds only when the session is valid (refreshing it if it can) and
 * the toml's `client_id` resolves to an app the account can see.
 *
 * `terminal` hands it the real terminal, so an expired session can be
 * renewed right there; without it nothing can prompt and it just fails.
 */
export function shopifyAppInfo(
	root: string,
	config: string,
	options: { terminal?: boolean } = {},
): { ok: boolean; info?: Record<string, unknown> } {
	try {
		const result = Bun.spawnSync(
			[resolveShopifyBin(root), "app", "info", "--config", config, "--json"],
			{
				cwd: root,
				stdin: options.terminal ? "inherit" : "ignore",
				stdout: "pipe",
				stderr: options.terminal ? "inherit" : "pipe",
				env: { ...process.env, SHOPIFY_CLI_NO_ANALYTICS: "1" },
			},
		);
		if (result.exitCode !== 0) return { ok: false };
		try {
			return { ok: true, info: JSON.parse(result.stdout.toString()) };
		} catch {
			return { ok: true };
		}
	} catch {
		return { ok: false };
	}
}

/** `shopify auth login`, with the terminal. Throws when it does not succeed. */
export function shopifyLogin(root: string): void {
	const result = Bun.spawnSync([resolveShopifyBin(root), "auth", "login"], {
		cwd: root,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (result.exitCode !== 0) throw new Error("`shopify auth login` failed");
}
