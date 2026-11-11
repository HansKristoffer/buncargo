import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeJsonParse } from "hanzio";
import { childProcessEnv } from "../core/child-env";
import { cliTool } from "../core/integration-cli";

/**
 * The Shopify CLI as buncargo drives it: which binary, which version, and
 * whether it is logged in, all without starting anything interactive.
 */

/**
 * The Shopify CLI, tested against 3.90 and newer 3.x, and 4.x; looked up in
 * the project root. Every run's environment is a project tool's like any
 * other child's (a `dotenv` import, a `SHOPIFY_*` token), without analytics.
 */
export const shopifyCli = cliTool({
	name: "shopify",
	versionArgs: ["version"],
	tested: { min: "3.90.0", below: "5.0.0" },
	env: () => ({ ...childProcessEnv(), SHOPIFY_CLI_NO_ANALYTICS: "1" }),
});

/** How long `app info` may take when nobody is watching; with the terminal it has no limit. */
const APP_INFO_TIMEOUT_MS = 15_000;

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
		// An unreadable store is still a session: the CLI decides.
		const parsedStore = safeJsonParse(store.sessionStore);
		const found = parsedStore.ok ? identities(parsedStore.data) : [];
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

/**
 * Whether the stored session can be trusted without asking the CLI: its
 * expiry is known and still ahead. One with no readable expiry is not
 * expired, but nothing says it is current either.
 */
export function isShopifySessionCurrent(
	session: ShopifySession,
	now = Date.now(),
): boolean {
	return (
		session.expiresAt !== undefined && !isShopifySessionExpired(session, now)
	);
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
	options: { terminal?: boolean; timeoutMs?: number } = {},
): { ok: boolean; timedOut?: boolean; info?: Record<string, unknown> } {
	try {
		const result = Bun.spawnSync(
			[shopifyCli.resolve([root]), "app", "info", "--config", config, "--json"],
			{
				cwd: root,
				stdin: options.terminal ? "inherit" : "ignore",
				stdout: "pipe",
				stderr: options.terminal ? "inherit" : "pipe",
				env: shopifyCli.env(),
				// A network call: it can hang, and nobody may be there to notice.
				timeout: options.terminal
					? undefined
					: (options.timeoutMs ?? APP_INFO_TIMEOUT_MS),
			},
		);
		if (result.exitedDueToTimeout) return { ok: false, timedOut: true };
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
	const result = Bun.spawnSync([shopifyCli.resolve([root]), "auth", "login"], {
		cwd: root,
		stdio: ["inherit", "inherit", "inherit"],
		env: shopifyCli.env(),
	});
	if (result.exitCode !== 0) throw new Error("`shopify auth login` failed");
}
