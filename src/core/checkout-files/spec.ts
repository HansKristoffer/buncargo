/**
 * `options.checkoutFiles`, normalized. Pure, so config validation can use it
 * without pulling in the store.
 */

export interface CheckoutFileSpec {
	/** POSIX path relative to the checkout root; also the store's key. */
	path: string;
	/** Copied in when neither the checkout nor the store has the file. */
	template?: string;
	/** Kept in this machine's store only: never exported or synced. */
	machine: boolean;
}

/**
 * Why a path cannot name a checkout file, or undefined when it can.
 *
 * The contract allows a POSIX path relative to the root with no `..`, no
 * leading `/` and no backslash. Empty and `.` segments are refused too, so a
 * file has exactly one spelling and therefore one store entry.
 */
export function checkoutPathError(path: string): string | undefined {
	if (!path) return "is empty";
	if (path.startsWith("/")) return "must be relative to the checkout root";
	if (path.includes("\\")) return "must use / as the separator";
	if (path.includes("\0")) return "contains a NUL byte";
	const segments = path.split("/");
	if (segments.includes("..")) return "must stay inside the checkout";
	if (segments.some((segment) => segment === "" || segment === "."))
		return "must not contain empty or . segments";
	return undefined;
}

/** Every problem with an `options.checkoutFiles` value, as config errors. */
export function checkoutFileErrors(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return ["options.checkoutFiles must be an array"];
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const at = `options.checkoutFiles.${index}`;
		const object =
			typeof entry === "object" && entry !== null
				? (entry as Record<string, unknown>)
				: undefined;
		const path = typeof entry === "string" ? entry : object?.path;
		const badTemplate =
			object?.template !== undefined && typeof object.template !== "string";
		const badMachine =
			object?.machine !== undefined && typeof object.machine !== "boolean";
		if (typeof path !== "string" || badTemplate || badMachine) {
			errors.push(`${at} must be a path or {path, template?, machine?}`);
			continue;
		}
		const pathError = checkoutPathError(path);
		if (pathError) errors.push(`${at} "${path}" ${pathError}`);
		const template = object?.template;
		const templateError =
			typeof template === "string" ? checkoutPathError(template) : undefined;
		if (templateError)
			errors.push(`${at}.template "${String(template)}" ${templateError}`);
		if (seen.has(path)) errors.push(`${at} "${path}" is listed twice`);
		seen.add(path);
	}
	return errors;
}

/** Normalize a value {@link checkoutFileErrors} accepted. */
export function checkoutFileSpecs(value: unknown): CheckoutFileSpec[] {
	const errors = checkoutFileErrors(value);
	if (errors.length > 0) throw new Error(errors.join("; "));
	return ((value ?? []) as unknown[]).map((entry) => {
		if (typeof entry === "string") return { path: entry, machine: false };
		const { path, template, machine } = entry as {
			path: string;
			template?: string;
			machine?: boolean;
		};
		return { path, template, machine: machine ?? false };
	});
}
