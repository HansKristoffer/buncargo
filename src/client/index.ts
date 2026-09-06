declare const __DEV__: boolean | undefined;

/**
 * Scope development cookies to a workspace. Production keeps the original name.
 * Expo callers pass their EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID from app code so
 * Metro can inline it; dependencies cannot read Expo public variables directly.
 * Other clients pass their development flag as the third argument.
 */
export function devCookiePrefix(
	base: string,
	workspaceId?: string,
	development = typeof __DEV__ !== "undefined" && __DEV__,
): string {
	if (!development || !workspaceId) {
		return base;
	}

	if (!/^[a-f0-9]{16}$/.test(workspaceId)) {
		throw new Error("Invalid buncargo workspace ID for development cookies");
	}

	return `${base}-${workspaceId}`;
}
