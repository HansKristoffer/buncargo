import { SECRETS_FIELDS, type ShapeChecks } from "./shape-checks";

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
				["expose", "interactive", "needsPublicUrls", "afterPreparation"],
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
				check(
					entry.expo,
					`${path}.expo`,
					typeof entry.expo === "boolean" || object(entry.expo),
					"a boolean or an object",
				);
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
