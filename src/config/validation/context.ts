/** Cross-entry namespace and port checks share one ownership map per validation. */
export function createValidationContext(errors: string[]) {
	const portOwners = new Map<number, string>();
	const namespaceOwners = new Map<string, string>();
	const claimName = (name: string, path: string) => {
		const previous = namespaceOwners.get(name);
		if (previous) {
			errors.push(
				`${path} conflicts with ${previous} in the computed ports/URLs namespace`,
			);
		} else {
			namespaceOwners.set(name, path);
		}
	};
	const claimPort = (port: number | undefined, path: string) => {
		if (!Number.isInteger(port) || (port ?? 0) < 1 || (port ?? 0) > 65535) {
			errors.push(`${path} must be an integer between 1 and 65535`);
			return;
		}

		const previous = portOwners.get(port as number);
		if (previous) {
			errors.push(`${path} duplicates port ${port} used by ${previous}`);
		} else {
			portOwners.set(port as number, path);
		}
	};

	return { errors, claimName, claimPort };
}
export type ValidationContext = ReturnType<typeof createValidationContext>;
