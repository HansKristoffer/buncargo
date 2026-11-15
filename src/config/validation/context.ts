import { isAbsolute, normalize } from "node:path";

/**
 * Cross-entry namespace and port checks share one ownership map per
 * validation; the path check is here so every field words it the same way.
 */
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
		const valid =
			typeof port === "number" &&
			Number.isInteger(port) &&
			port >= 1 &&
			port <= 65535;
		if (!valid) {
			errors.push(`${path} must be an integer between 1 and 65535`);
			return;
		}

		const previous = portOwners.get(port);
		if (previous) {
			errors.push(`${path} duplicates port ${port} used by ${previous}`);
		} else {
			portOwners.set(port, path);
		}
	};

	const checkRelativePath = (path: string, value: string | undefined) => {
		if (!value) return;
		if (isAbsolute(value)) {
			errors.push(`${path} must be a relative path inside the repo.`);
		}

		const normalized = normalize(value).replace(/\\/g, "/");
		if (normalized === ".." || normalized.startsWith("../")) {
			errors.push(`${path} cannot point outside the repository root.`);
		}
	};

	return { errors, claimName, claimPort, checkRelativePath };
}
export type ValidationContext = ReturnType<typeof createValidationContext>;
