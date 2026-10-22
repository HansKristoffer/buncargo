import { isString } from "hanzio";
import { checkoutFileErrors } from "../../core/checkout-files/spec";
import { SECRETS_FIELDS, type ShapeChecks } from "./shape-checks";

export function validateSupplementShapes(
	value: Record<string, unknown>,
	checks: ShapeChecks,
): void {
	const { errors, object, record, check, strings, fields, duration } = checks;
	if (
		value.secrets !== undefined &&
		value.secrets !== false &&
		record(value.secrets, "secrets")
	)
		fields(value.secrets, "secrets.", SECRETS_FIELDS, "string");
	check(
		value.unsetEnv,
		"unsetEnv",
		strings(value.unsetEnv),
		"an array of variable names",
	);
	for (const key of ["docker", "options", "prisma", "seed", "hooks"]) {
		if (value[key] !== undefined) record(value[key], key);
	}
	if (object(value.docker))
		fields(
			value.docker,
			"docker.",
			["binary", "generatedFile", "writeStrategy", "runtime", "startCommand"],
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
		fields(value.seed, "seed.", ["beforeApps"], "boolean");
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
	check(
		value.preflight,
		"preflight",
		Array.isArray(value.preflight) &&
			value.preflight.every(
				(step) =>
					object(step) &&
					typeof step.name === "string" &&
					typeof step.run === "function" &&
					(step.apps === undefined ||
						(Array.isArray(step.apps) && step.apps.every(isString))),
			),
		"an array of { name, apps?, run }",
	);
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
	validateTypecheckShape(value.typecheck, checks);
	validateCheckShape(value.check, checks);
	validatePredeployShape(value.predeploy, checks);
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
		errors.push(...checkoutFileErrors(options.checkoutFiles));
		fields(options, "options.", ["worktreeIsolation", "verbose"], "boolean");
		fields(options, "options.", ["primaryApp"], "string");
		if (options.autoShutdown !== false)
			duration(options.autoShutdown, "options.autoShutdown");
		if (
			options.onAppFailure !== undefined &&
			options.onAppFailure !== "keep-others" &&
			options.onAppFailure !== "stop-run"
		)
			errors.push('options.onAppFailure must be "keep-others" or "stop-run"');
		for (const name of ["hosts", "envFile"]) {
			const option = options[name];
			if (option === undefined || typeof option === "boolean") continue;
			if (!record(option, `options.${name}`)) continue;
			if (name === "hosts") {
				fields(option, "options.hosts.", ["tld"], "string");
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

function rootRelative(entry: string) {
	return !(
		entry.startsWith("/") ||
		/^[A-Za-z]:[\\/]/.test(entry) ||
		entry.split(/[\\/]/).includes("..")
	);
}

function pathList(value: unknown, path: string, checks: ShapeChecks) {
	if (value === undefined) return;
	if (!checks.strings(value)) {
		checks.errors.push(
			`${path} must be an array of paths or globs relative to the root`,
		);
		return;
	}
	for (const entry of value)
		if (!rootRelative(entry))
			checks.errors.push(
				`${path}: "${entry}" must be relative to the root and stay inside it`,
			);
}

function unknownKeys(
	value: Record<string, unknown>,
	path: string,
	known: readonly string[],
	errors: string[],
) {
	for (const key of Object.keys(value))
		if (!known.includes(key))
			errors.push(`${path}.${key} is not an option (${known.join(", ")})`);
}

/**
 * `typecheck`: lists of paths inside the root. Shared with `buncargo
 * typecheck`, which reads only this key of the config rather than building a
 * whole dev environment.
 */
export function validateTypecheckShape(
	value: unknown,
	checks: ShapeChecks,
): void {
	const { errors, record, check, strings, fields } = checks;
	if (value === undefined || !record(value, "typecheck")) return;
	unknownKeys(
		value,
		"typecheck",
		["include", "exclude", "concurrency", "groups"],
		errors,
	);
	pathList(value.include, "typecheck.include", checks);
	pathList(value.exclude, "typecheck.exclude", checks);
	check(
		value.concurrency,
		"typecheck.concurrency",
		Number.isInteger(value.concurrency) && Number(value.concurrency) > 0,
		"a positive integer",
	);
	if (value.groups === undefined || !record(value.groups, "typecheck.groups"))
		return;
	for (const [name, group] of Object.entries(value.groups)) {
		const path = `typecheck.groups.${name}`;
		if (!record(group, path)) continue;
		unknownKeys(group, path, ["only", "exclude", "rootConfig"], errors);
		check(
			group.only,
			`${path}.only`,
			strings(group.only),
			"an array of workspaces",
		);
		pathList(group.exclude, `${path}.exclude`, checks);
		fields(group, `${path}.`, ["rootConfig"], "boolean");
	}
}

/** `check.docs`: a boolean, or `{ paths }` with its exemptions. */
function validateDocsCheckShape(value: unknown, checks: ShapeChecks): void {
	const { errors, record, fields } = checks;
	if (value === undefined || typeof value === "boolean") return;
	if (!record(value, "check.docs")) return;
	unknownKeys(value, "check.docs", ["paths"], errors);

	const paths = value.paths;
	if (paths === undefined || typeof paths === "boolean") return;
	if (!record(paths, "check.docs.paths")) return;
	unknownKeys(paths, "check.docs.paths", ["exempt"], errors);
	if (paths.exempt === undefined) return;
	if (!Array.isArray(paths.exempt)) {
		errors.push("check.docs.paths.exempt must be an array");
		return;
	}

	for (const [index, exemption] of paths.exempt.entries()) {
		const path = `check.docs.paths.exempt.${index}`;
		if (!record(exemption, path)) continue;
		unknownKeys(exemption, path, ["file", "path", "reason"], errors);
		for (const key of ["file", "reason"])
			if (typeof exemption[key] !== "string" || !exemption[key])
				errors.push(`${path}.${key} must be a nonempty string`);
		fields(exemption, `${path}.`, ["path"], "string");
	}
}

/** `check`; shared with `buncargo check`, which reads only this key. */
export function validateCheckShape(value: unknown, checks: ShapeChecks): void {
	const { errors, record, fields } = checks;
	if (value === undefined || !record(value, "check")) return;
	unknownKeys(
		value,
		"check",
		["gates", "testCommand", "testExclude", "docs"],
		errors,
	);
	fields(value, "check.", ["testCommand"], "string");
	validateDocsCheckShape(value.docs, checks);
	pathList(value.testExclude, "check.testExclude", checks);
	if (value.gates === undefined) return;
	if (!Array.isArray(value.gates)) {
		errors.push("check.gates must be an array");
		return;
	}
	for (const [index, gate] of value.gates.entries()) {
		const path = `check.gates.${index}`;
		if (!record(gate, path)) continue;
		unknownKeys(
			gate,
			path,
			["name", "command", "cwd", "when", "staged"],
			errors,
		);
		for (const key of ["name", "command"])
			if (typeof gate[key] !== "string" || !gate[key])
				errors.push(`${path}.${key} must be a nonempty string`);
		fields(gate, `${path}.`, ["cwd"], "string");
		fields(gate, `${path}.`, ["staged"], "boolean");
		pathList(gate.when, `${path}.when`, checks);
	}
}

/** `predeploy`; shared with `buncargo predeploy`, which reads only this key. */
export function validatePredeployShape(
	value: unknown,
	checks: ShapeChecks,
): void {
	const { errors, record, check, strings, fields, duration } = checks;
	if (value === undefined || !record(value, "predeploy")) return;
	const hooks = ["beforeMigrate", "afterMigrate", "afterSeed"];
	unknownKeys(
		value,
		"predeploy",
		["environmentVars", "production", "seed", "retry", ...hooks],
		errors,
	);
	for (const key of ["environmentVars", "production"])
		check(
			value[key],
			`predeploy.${key}`,
			strings(value[key]),
			"an array of names",
		);
	check(
		value.seed,
		"predeploy.seed",
		value.seed === false ||
			(typeof value.seed === "string" && value.seed.length > 0),
		"false or a nonempty command",
	);
	fields(value, "predeploy.", hooks, "function");
	if (value.retry === undefined || value.retry === false) return;
	if (!record(value.retry, "predeploy.retry")) return;
	unknownKeys(
		value.retry,
		"predeploy.retry",
		["match", "attempts", "delayMs"],
		errors,
	);
	fields(value.retry, "predeploy.retry.", ["match"], "string");
	check(
		value.retry.attempts,
		"predeploy.retry.attempts",
		Number.isInteger(value.retry.attempts) && Number(value.retry.attempts) > 0,
		"a positive integer",
	);
	duration(value.retry.delayMs, "predeploy.retry.delayMs");
}
