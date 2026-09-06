import { devCookiePrefix as prefixForWorkspace } from "../client/index";
import { devWorkspaceId } from "../core/runtime-flags";

/** Use Buncargo's workspace identity; preserve production and E2E cookie names. */
export function devCookiePrefix(base: string, env = process.env): string {
	return prefixForWorkspace(
		base,
		devWorkspaceId(env),
		env.NODE_ENV !== "production" && env.E2E_TEST !== "true",
	);
}
