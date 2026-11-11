import { envName } from "../../core/ports";
import { SECRETS_FIELDS, type ShapeChecks } from "./shape-checks";

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

export function validateEntryShapes(
	value: Record<string, unknown>,
	checks: ShapeChecks,
): void {
	const {
		errors,
		object,
		record,
		check,
		strings,
		fields,
		duration,
		envValues,
	} = checks;
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
			fields(
				entry,
				`${path}.`,
				[
					"expose",
					"interactive",
					"essential",
					"needsPublicUrls",
					"afterPreparation",
				],
				"boolean",
			);
			check(
				entry.exposeProtocol,
				`${path}.exposeProtocol`,
				entry.exposeProtocol === "http" || entry.exposeProtocol === "tcp",
				'"http" or "tcp"',
			);
			duration(entry.healthTimeout, `${path}.healthTimeout`);
			envValues(entry.staticEnv, `${path}.staticEnv`);
			if (kind === "apps") {
				fields(
					entry,
					`${path}.`,
					["cwd", "prodCommand", "buildCommand"],
					"string",
				);
				fields(entry, `${path}.`, ["envVars"], "function");
				duration(entry.stopGraceMs, `${path}.stopGraceMs`);
				check(
					entry.devCommand,
					`${path}.devCommand`,
					typeof entry.devCommand === "string" || entry.devCommand === false,
					"a command string or false",
				);
				check(
					entry.healthEndpoint,
					`${path}.healthEndpoint`,
					typeof entry.healthEndpoint === "string" ||
						entry.healthEndpoint === false,
					"a path string or false",
				);
				if (
					entry.secrets !== undefined &&
					entry.secrets !== false &&
					record(entry.secrets, `${path}.secrets`)
				) {
					fields(entry.secrets, `${path}.secrets.`, SECRETS_FIELDS, "string");
					check(
						entry.secrets.required,
						`${path}.secrets.required`,
						strings(entry.secrets.required),
						"an array of nonempty strings",
					);
				}
				fields(entry, `${path}.`, ["prebuild", "exclusive"], "string");
				if (entry.watch !== undefined && record(entry.watch, `${path}.watch`)) {
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
						entry.watch.debounceMs,
						`${path}.watch.debounceMs`,
						Number.isInteger(entry.watch.debounceMs) &&
							(entry.watch.debounceMs as number) >= 0,
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
					typeof entry.entryPath === "string" &&
						entry.entryPath.startsWith("/"),
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
						if (!record(capture, `${path}.captures.${name}`)) continue;
						if (!(capture.pattern instanceof RegExp))
							errors.push(
								`${path}.captures.${name}.pattern must be a regular expression`,
							);
						if (!["publicUrl", "value", "event"].includes(String(capture.as)))
							errors.push(
								`${path}.captures.${name}.as must be "publicUrl", "value" or "event"`,
							);
						fields(capture, `${path}.captures.${name}.`, ["label"], "string");
						check(
							capture.env,
							`${path}.captures.${name}.env`,
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
			} else {
				fields(
					entry,
					`${path}.`,
					["serviceName", "database", "user", "password"],
					"string",
				);
				fields(entry, `${path}.`, ["urlTemplate"], "function");
				check(
					entry.healthCheck,
					`${path}.healthCheck`,
					entry.healthCheck === false ||
						typeof entry.healthCheck === "function" ||
						(typeof entry.healthCheck === "string" &&
							["pg_isready", "redis-cli", "http", "tcp"].includes(
								entry.healthCheck,
							)),
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
				if (
					entry.docker !== undefined &&
					record(entry.docker, `${path}.docker`)
				) {
					check(
						entry.docker.kind,
						`${path}.docker.kind`,
						entry.docker.kind === "preset",
						'"preset" (or omit kind for raw Compose)',
					);
					if (
						entry.docker.kind === "preset" &&
						entry.docker.service !== undefined
					)
						record(entry.docker.service, `${path}.docker.service`);
				}
			}
		}
	}
}
