import { SECRETS_FIELDS, type ShapeChecks } from "./shape-checks";

export function validateSupplementShapes(
	value: Record<string, unknown>,
	checks: ShapeChecks,
): void {
	const { errors, object, record, check, strings, fields, duration } = checks;
	if (value.secrets !== undefined && record(value.secrets, "secrets"))
		fields(value.secrets, "secrets.", SECRETS_FIELDS, "string");
	for (const key of ["docker", "options", "prisma", "seed", "hooks"]) {
		if (value[key] !== undefined) record(value[key], key);
	}
	if (object(value.docker))
		fields(
			value.docker,
			"docker.",
			["binary", "generatedFile", "writeStrategy", "runtime"],
			"string",
		);
	if (object(value.prisma))
		fields(
			value.prisma,
			"prisma.",
			["cwd", "migrations", "service", "urlEnvVar", "generate"],
			"string",
		);
	if (object(value.seed)) {
		fields(value.seed, "seed.", ["command", "cwd"], "string");
		fields(value.seed, "seed.", ["check"], "function");
	}
	if (object(value.prisma))
		check(
			value.prisma.generateCheck,
			"prisma.generateCheck",
			typeof value.prisma.generateCheck === "function",
			"a function",
		);
	if (object(value.hooks))
		for (const [key, hook] of Object.entries(value.hooks))
			check(hook, `hooks.${key}`, typeof hook === "function", "a function");
	if (value.migrations !== undefined) {
		if (!Array.isArray(value.migrations))
			errors.push("migrations must be an array");
		else
			for (const [index, migration] of value.migrations.entries())
				if (record(migration, `migrations.${index}`))
					fields(
						migration,
						`migrations.${index}.`,
						["name", "command", "cwd"],
						"string",
					);
	}
	if (value.integrations !== undefined) {
		if (!Array.isArray(value.integrations))
			errors.push("integrations must be an array");
		else
			for (const [index, entry] of value.integrations.entries()) {
				const path = `integrations.${index}`;
				if (!record(entry, path)) continue;
				if (
					typeof entry.name !== "string" ||
					!/^[a-z][a-z0-9-]*$/.test(entry.name)
				)
					errors.push(`${path}.name must be a lowercase name`);
				for (const key of [
					"config",
					"describe",
					"appEnv",
					"describeApp",
					"bannerHint",
				])
					check(
						entry[key],
						`${path}.${key}`,
						typeof entry[key] === "function",
						"a function",
					);
			}
	}
	if (value.generatedFiles !== undefined) {
		if (!Array.isArray(value.generatedFiles))
			errors.push("generatedFiles must be an array");
		else
			for (const [index, entry] of value.generatedFiles.entries()) {
				const path = `generatedFiles.${index}`;
				if (!record(entry, path)) continue;
				if (typeof entry.path !== "string" || !entry.path)
					errors.push(`${path}.path must be a nonempty string`);
				if (typeof entry.render !== "function")
					errors.push(`${path}.render must be a function`);
				fields(entry, `${path}.`, ["gitignore"], "boolean");
			}
	}
	if (value.checks !== undefined) {
		if (!Array.isArray(value.checks)) errors.push("checks must be an array");
		else
			for (const [index, entry] of value.checks.entries()) {
				const path = `checks.${index}`;
				if (!record(entry, path)) continue;
				if (typeof entry.name !== "string" || !entry.name)
					errors.push(`${path}.name must be a nonempty string`);
				if (typeof entry.check !== "function")
					errors.push(`${path}.check must be a function`);
				check(
					entry.fix,
					`${path}.fix`,
					typeof entry.fix === "string" || typeof entry.fix === "function",
					"a command string or a function",
				);
				fields(entry, `${path}.`, ["fixDescription", "severity"], "string");
				fields(entry, `${path}.`, ["fast"], "boolean");
			}
	}
	for (const kind of ["tasks", "profiles"] as const) {
		const entries = value[kind];
		if (entries === undefined || !record(entries, kind)) continue;
		for (const [name, entry] of Object.entries(entries)) {
			const path = `${kind}.${name}`;
			// Colons allowed: `shop:seed` is how package scripts are named too.
			if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(name))
				errors.push(`${path} has an invalid name`);
			if (!record(entry, path)) continue;
			fields(entry, `${path}.`, ["description"], "string");
			if (kind === "profiles") {
				if (!strings(entry.apps) || entry.apps.length === 0)
					errors.push(`${path}.apps must be a nonempty array of app names`);
				continue;
			}
			if (typeof entry.command !== "string" || !entry.command)
				errors.push(`${path}.command must be a nonempty string`);
			fields(entry, `${path}.`, ["app", "cwd"], "string");
			check(
				entry.requiredServices,
				`${path}.requiredServices`,
				strings(entry.requiredServices),
				"an array of nonempty strings",
			);
		}
	}
	if (object(value.options)) {
		const options = value.options;
		if (options.envFiles !== undefined) {
			if (!Array.isArray(options.envFiles))
				errors.push("options.envFiles must be an array");
			else
				for (const [index, file] of options.envFiles.entries()) {
					if (typeof file === "string" && file.length > 0) continue;
					if (
						!object(file) ||
						typeof file.path !== "string" ||
						!file.path ||
						(file.optional !== undefined && typeof file.optional !== "boolean")
					)
						errors.push(
							`options.envFiles.${index} must be a path or {path, optional}`,
						);
				}
		}
		fields(options, "options.", ["worktreeIsolation", "verbose"], "boolean");
		fields(
			options,
			"options.",
			["primaryApp", "frontendApp", "expoApiApp"],
			"string",
		);
		if (options.autoShutdown !== false)
			duration(options.autoShutdown, "options.autoShutdown");
		for (const name of ["hosts", "envFile"]) {
			const option = options[name];
			if (option === undefined || typeof option === "boolean") continue;
			if (!record(option, `options.${name}`)) continue;
			if (name === "hosts") {
				fields(option, "options.hosts.", ["tld", "primaryApp"], "string");
				check(
					option.services,
					"options.hosts.services",
					option.services === true || strings(option.services),
					"true or an array of service names",
				);
			} else {
				fields(option, "options.envFile.", ["path", "createFrom"], "string");
				fields(option, "options.envFile.", ["values"], "function");
			}
		}
	}
}
