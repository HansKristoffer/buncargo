/** Validate dynamic config shapes before semantic validation dereferences them. */
export function validateConfigShape(value: unknown): string[] {
	const errors: string[] = [];
	const object = (input: unknown): input is Record<string, unknown> =>
		typeof input === "object" && input !== null && !Array.isArray(input);
	const record = (
		input: unknown,
		path: string,
	): input is Record<string, unknown> => {
		if (object(input)) return true;
		errors.push(`${path} must be an object`);
		return false;
	};
	const check = (
		input: unknown,
		path: string,
		valid: boolean,
		expected: string,
	) => {
		if (input !== undefined && !valid)
			errors.push(`${path} must be ${expected}`);
	};
	const strings = (input: unknown) =>
		Array.isArray(input) &&
		input.every((entry) => typeof entry === "string" && entry.length > 0);
	const fields = (
		input: Record<string, unknown>,
		path: string,
		keys: string[],
		type: string,
	) => {
		for (const key of keys)
			check(
				input[key],
				`${path}${key}`,
				typeof input[key] === type,
				`a ${type}`,
			);
	};
	const duration = (input: unknown, path: string) =>
		check(
			input,
			path,
			typeof input === "number" && Number.isFinite(input) && input > 0,
			"a finite positive duration in milliseconds",
		);
	const envValues = (input: unknown, path: string) => {
		if (input === undefined || !record(input, path)) return;
		for (const [name, item] of Object.entries(input))
			check(
				item,
				`${path}.${name}`,
				typeof item === "string" ||
					(typeof item === "number" && Number.isFinite(item)),
				"a string or finite number",
			);
	};
	if (!record(value, "config")) return errors;
	fields(value, "", ["projectPrefix"], "string");
	fields(value, "", ["env"], "function");
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
				["expose", "interactive", "needsPublicUrls"],
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
				for (const key of ["requiredServices", "requiredApps"])
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
			["cwd", "service", "urlEnvVar", "generate"],
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
	if (object(value.options)) {
		const options = value.options;
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
	return errors;
}
