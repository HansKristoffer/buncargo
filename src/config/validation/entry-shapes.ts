import { envName } from "../../core/ports";
import {
	APP_KEYS,
	CAPTURE_KEYS,
	keysChecked,
	RENAMED_KEYS,
	SERVICE_KEYS,
	unknownKeyErrors,
	WATCH_KEYS,
} from "./key-tables";
import type { ShapeChecks } from "./shape-checks";

/**
 * Two keys that spell one env name would write each other's `<NAME>_PORT` and
 * `<NAME>_URL`: `my-db` and `my_db` are both `MY_DB`. A key used twice as is
 * is the namespace check's to report, so only differing keys count here.
 */
function sharedEnvNames(value: Record<string, unknown>): string[] {
	const owners = new Map<string, { keys: Set<string>; paths: string[] }>();
	for (const kind of ["services", "apps"] as const) {
		const entries = value[kind];
		if (typeof entries !== "object" || entries === null) continue;
		for (const key of Object.keys(entries)) {
			const stem = envName(key);
			const owner = owners.get(stem) ?? { keys: new Set(), paths: [] };
			owner.keys.add(key);
			owner.paths.push(`${kind}.${key}`);
			owners.set(stem, owner);
		}
	}
	return [...owners]
		.filter(([, owner]) => owner.keys.size > 1)
		.map(
			([stem, { paths }]) =>
				`${paths.join(" and ")} share the env name ${stem} (${stem}_PORT, ${stem}_URL): rename one of them`,
		);
}

/** The checks only an app takes: commands, watch, captures, actions and the dependency lists. */
function validateAppEntry(
	entry: Record<string, unknown>,
	path: string,
	checks: ShapeChecks,
): void {
	const { errors, object, record, check, strings, fields, secretsScope } =
		checks;
	check(
		entry.devCommand,
		`${path}.devCommand`,
		typeof entry.devCommand === "string" || entry.devCommand === false,
		"a command string or false",
	);
	check(
		entry.healthEndpoint,
		`${path}.healthEndpoint`,
		typeof entry.healthEndpoint === "string" || entry.healthEndpoint === false,
		"a path string or false",
	);
	secretsScope(entry.secrets, `${path}.secrets`);

	if (entry.watch !== undefined && record(entry.watch, `${path}.watch`)) {
		const { debounceMs } = entry.watch;
		errors.push(...unknownKeyErrors(entry.watch, `${path}.watch`, WATCH_KEYS));
		check(
			entry.watch.paths,
			`${path}.watch.paths`,
			strings(entry.watch.paths) && entry.watch.paths.length > 0,
			"a nonempty array of paths",
		);
		check(
			entry.watch.ignore,
			`${path}.watch.ignore`,
			strings(entry.watch.ignore),
			"an array of globs",
		);
		check(
			debounceMs,
			`${path}.watch.debounceMs`,
			typeof debounceMs === "number" &&
				Number.isInteger(debounceMs) &&
				debounceMs >= 0,
			"a whole number of milliseconds",
		);
		if (entry.watch.paths === undefined)
			errors.push(`${path}.watch.paths is required`);
	}

	check(
		entry.readyWhen,
		`${path}.readyWhen`,
		entry.readyWhen instanceof RegExp,
		"a RegExp",
	);
	check(
		entry.entryPath,
		`${path}.entryPath`,
		typeof entry.entryPath === "string" && entry.entryPath.startsWith("/"),
		'a path starting with "/"',
	);
	check(
		entry.actions,
		`${path}.actions`,
		Array.isArray(entry.actions) &&
			entry.actions.every((action) => object(action)),
		"an array of { key, label, open }",
	);

	if (
		entry.captures !== undefined &&
		record(entry.captures, `${path}.captures`)
	)
		for (const [name, capture] of Object.entries(entry.captures)) {
			const capturePath = `${path}.captures.${name}`;
			if (!record(capture, capturePath)) continue;
			errors.push(...unknownKeyErrors(capture, capturePath, CAPTURE_KEYS));
			if (!(capture.pattern instanceof RegExp))
				errors.push(`${capturePath}.pattern must be a regular expression`);
			if (!["publicUrl", "value", "event"].includes(String(capture.as)))
				errors.push(
					`${capturePath}.as must be "publicUrl", "value" or "event"`,
				);
			for (const type of ["boolean", "string"] as const)
				fields(
					capture,
					`${capturePath}.`,
					keysChecked(CAPTURE_KEYS, type),
					type,
				);
			check(
				capture.env,
				`${capturePath}.env`,
				typeof capture.env === "string" &&
					/^[A-Za-z_][A-Za-z0-9_]*$/.test(capture.env),
				"an env var name",
			);
		}

	for (const key of [
		"requiredServices",
		"requiredApps",
		"startAfter",
		"restartOn",
	])
		check(
			entry[key],
			`${path}.${key}`,
			strings(entry[key]),
			"an array of nonempty strings",
		);
}

/** The checks only a service takes: its health check, env sources and Docker definition. */
function validateServiceEntry(
	entry: Record<string, unknown>,
	path: string,
	checks: ShapeChecks,
): void {
	const { record, check } = checks;
	check(
		entry.healthCheck,
		`${path}.healthCheck`,
		entry.healthCheck === false ||
			typeof entry.healthCheck === "function" ||
			(typeof entry.healthCheck === "string" &&
				["pg_isready", "redis-cli", "http", "tcp"].includes(entry.healthCheck)),
		"a built-in health check, function, or false",
	);

	if (entry.env !== undefined && record(entry.env, `${path}.env`)) {
		for (const [key, source] of Object.entries(entry.env))
			check(
				source,
				`${path}.env.${key}`,
				typeof source === "string" &&
					["url", "port", "secondaryPort"].includes(source),
				'"url", "port", or "secondaryPort"',
			);
	}

	if (entry.docker !== undefined && record(entry.docker, `${path}.docker`)) {
		check(
			entry.docker.kind,
			`${path}.docker.kind`,
			entry.docker.kind === "preset",
			'"preset" (or omit kind for raw Compose)',
		);
		if (entry.docker.kind === "preset" && entry.docker.service !== undefined)
			record(entry.docker.service, `${path}.docker.service`);
	}
}

export function validateEntryShapes(
	value: Record<string, unknown>,
	checks: ShapeChecks,
): void {
	const { errors, record, check, fields, duration, envValues } = checks;
	errors.push(...sharedEnvNames(value));

	for (const kind of ["services", "apps"] as const) {
		const entries = value[kind];
		if (entries === undefined || !record(entries, kind)) continue;

		for (const [name, entry] of Object.entries(entries)) {
			const path = `${kind}.${name}`;
			if (
				!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) ||
				["__proto__", "constructor", "prototype"].includes(name)
			)
				errors.push(`${path} has an invalid name`);
			if (!record(entry, path)) continue;

			const table = kind === "apps" ? APP_KEYS : SERVICE_KEYS;
			errors.push(...unknownKeyErrors(entry, path, table, RENAMED_KEYS[kind]));
			for (const type of ["boolean", "string", "function"] as const)
				fields(entry, `${path}.`, keysChecked(table, type), type);
			for (const key of keysChecked(table, "duration"))
				duration(entry[key], `${path}.${key}`);
			check(
				entry.exposeProtocol,
				`${path}.exposeProtocol`,
				entry.exposeProtocol === "http" || entry.exposeProtocol === "tcp",
				'"http" or "tcp"',
			);
			envValues(entry.staticEnv, `${path}.staticEnv`);

			if (kind === "apps") validateAppEntry(entry, path, checks);
			else validateServiceEntry(entry, path, checks);
		}
	}
}
