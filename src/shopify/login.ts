import {
	isShopifySessionCurrent,
	readShopifySession,
	shopifyAppInfo,
	shopifyLogin,
} from "./cli";

/**
 * Make sure the Shopify CLI session is usable before `shopify app dev`
 * starts, while the real terminal is still there: a login that fails inside
 * the run fails with "unable to prompt" and takes the extensions down with it.
 *
 * A stored session that has not expired is trusted (no process spawned). An
 * expired one is renewed by a cheap authenticated command, `app info`, which
 * refreshes the token itself or asks to log in; only if that fails does it
 * fall back to `shopify auth login`. Without a terminal nothing can prompt,
 * so it fails with the command to run instead.
 */
export function ensureShopifyLogin(input: {
	root: string;
	config: string;
	/** The toml has a real client_id: `app info` would otherwise ask to link. */
	linked: boolean;
	interactive: boolean;
	sessionFile?: string;
	env?: Record<string, string | undefined>;
}): void {
	// Token authentication (CI, automation) has no stored session to check:
	// the CLI uses the token itself.
	if ((input.env ?? process.env).SHOPIFY_CLI_PARTNERS_TOKEN) return;
	const session = readShopifySession(input.sessionFile);
	// Trusted only with an expiry that is known and ahead; any other session
	// is asked about below.
	if (session && isShopifySessionCurrent(session)) return;
	if (
		session &&
		input.linked &&
		shopifyAppInfo(input.root, input.config, { terminal: input.interactive }).ok
	)
		return;
	if (!input.interactive) {
		const state = !session
			? "not logged in to the Shopify CLI."
			: session.expiresAt
				? "the Shopify CLI session has expired and cannot be renewed without a terminal."
				: "the Shopify CLI session could not be confirmed (its expiry is unreadable) and cannot be renewed without a terminal.";
		throw new Error(`${state} Run \`buncargo shopify login\`.`);
	}
	shopifyLogin(input.root);
}
