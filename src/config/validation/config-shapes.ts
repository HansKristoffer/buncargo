import { isString } from "hanzio";
import { checkoutFileErrors } from "../../core/checkout-files/spec";
import { validateWatchShape } from "./entry-shapes";
import {
	CONFIG_KEYS,
	DOCKER_KEYS,
	EGRESS_GUARD_KEYS,
	ENV_FILE_KEYS,
	HOSTS_KEYS,
	keysChecked,
	LINK_KEYS,
	OPTIONS_KEYS,
	PRISMA_KEYS,
	PROFILE_KEYS,
	RENAMED_KEYS,
	SEED_KEYS,
	TASK_KEYS,
	unknownKeyErrors,
} from "./key-tables";
import type { ShapeChecks } from "./shape-checks";

/** `docker`, `prisma`, `seed` and `hooks`: the sections made of known keys. */
function validateSectionShapes(
	value: Record<string, unknown>,
	checks: ShapeChecks,
): void {
	const { errors, object, record, check, fields } = checks;
	for (const key of ["docker", "options", "prisma", "seed", "hooks"]) {
		if (value[key] !== undefined) record(value[key], key);
	}

	if (object(value.docker)) {
		errors.push(...unknownKeyErrors(value.docker, "docker", DOCKER_KEYS));
		for (const type of ["string", "boolean"] as const)
			fields(value.docker, "docker.", keysChecked(DOCKER_KEYS, type), type);
	}

	if (object(value.prisma)) {
		const { urlEnvVar, generateCheck } = value.prisma;
		errors.push(...unknownKeyErrors(value.prisma, "prisma", PRISMA_KEYS));
		fields(
			value.prisma,
			"prisma.",
			keysChecked(PRISMA_KEYS, "string"),
			"string",
		);
		check(
			urlEnvVar,
			"prisma.urlEnvVar",
			typeof urlEnvVar === "string" ||
				(Array.isArray(urlEnvVar) &&
					urlEnvVar.length > 0 &&
					urlEnvVar.every((name) => typeof name === "string")),
			"a variable name or a non-empty list of them",
		);
		check(
			generateCheck,
			"prisma.generateCheck",
			typeof generateCheck === "function" || generateCheck === "schema-hash",
			'a function or "schema-hash"',
		);
	}

	if (object(value.seed)) {
		errors.push(...unknownKeyErrors(value.seed, "seed", SEED_KEYS));
		for (const type of ["string", "function", "boolean"] as const)
			fields(value.seed, "seed.", keysChecked(SEED_KEYS, type), type);
		checks.secretsScope(value.seed.secrets, "seed.secrets");
	}

	if (object(value.hooks))
		for (const [key, hook] of Object.entries(value.hooks))
			check(hook, `hooks.${key}`, typeof hook === "function", "a function");
}

/** `migrations`, `integrations`, `preflight`, `generatedFiles` and `setupChecks`: the lists of entries. */
function validateListShapes(
	value: Record<string, unknown>,
	checks: ShapeChecks,
): void {
	const { errors, object, record, check, fields } = checks;
	if (value.migrations !== undefined) {
		if (!Array.isArray(value.migrations))
			errors.push("migrations must be an array");
		else
			for (const [index, migration] of value.migrations.entries())
				if (record(migration, `migrations.${index}`)) {
					fields(
						migration,
						`migrations.${index}.`,
						["name", "command", "cwd"],
						"string",
					);
					checks.secretsScope(migration.secrets, `migrations.${index}.secrets`);
				}
	}

	if (value.integrations !== undefined) {
		validateIntegrationsShape(value.integrations, "integrations", checks);
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

	if (value.setupChecks !== undefined) {
		if (!Array.isArray(value.setupChecks))
			errors.push("setupChecks must be an array");
		else
			for (const [index, entry] of value.setupChecks.entries()) {
				const path = `setupChecks.${index}`;
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
}

/** Validate an `integrations` array (top-level or per-profile). */
function validateIntegrationsShape(
	value: unknown,
	pathPrefix: string,
	checks: ShapeChecks,
): void {
	const { errors, record, check } = checks;
	if (!Array.isArray(value)) {
		errors.push(`${pathPrefix} must be an array`);
		return;
	}
	for (const [index, entry] of value.entries()) {
		const path = `${pathPrefix}.${index}`;
		if (!record(entry, path)) continue;
		if (typeof entry.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(entry.name))
			errors.push(`${path}.name must be a lowercase name`);
		for (const key of [
			"config",
			"describe",
			"exportEnv",
			"appEnv",
			"onAppReady",
			"secretScopes",
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

/** Validate `egressGuard` on the top-level config or a profile. */
function validateEgressGuardShape(
	value: unknown,
	path: string,
	checks: ShapeChecks,
): void {
	const { errors, record, check, strings, fields } = checks;
	if (value === undefined || typeof value === "boolean") return;
	if (!record(value, path)) return;
	errors.push(...unknownKeyErrors(value, path, EGRESS_GUARD_KEYS));
	fields(value, `${path}.`, ["enabled"], "boolean");
	check(
		value.allow,
		`${path}.allow`,
		strings(value.allow),
		"an array of host patterns",
	);
	check(
		value.mode,
		`${path}.mode`,
		value.mode === "block" || value.mode === "warn",
		'"block" or "warn"',
	);
	check(
		value.apps,
		`${path}.apps`,
		strings(value.apps),
		"an array of app names",
	);
}

/** `tasks` and `profiles`: named entries that share a name rule. */
function validateNamedEntryShapes(
	value: Record<string, unknown>,
	checks: ShapeChecks,
): void {
	const { errors, record, check, strings, fields } = checks;
	for (const kind of ["tasks", "profiles"] as const) {
		const entries = value[kind];
		if (entries === undefined || !record(entries, kind)) continue;

		for (const [name, entry] of Object.entries(entries)) {
			const path = `${kind}.${name}`;
			// Colons allowed: `shop:seed` is how package scripts are named too.
			if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(name))
				errors.push(`${path} has an invalid name`);
			if (!record(entry, path)) continue;
			errors.push(
				...unknownKeyErrors(
					entry,
					path,
					kind === "profiles" ? PROFILE_KEYS : TASK_KEYS,
				),
			);
			fields(entry, `${path}.`, ["description"], "string");

			if (kind === "profiles") {
				if (entry.apps !== undefined) {
					if (!strings(entry.apps) || entry.apps.length === 0)
						errors.push(`${path}.apps must be a nonempty array of app names`);
				}
				if (entry.env !== undefined && typeof entry.env !== "function") {
					checks.envValues(entry.env, `${path}.env`);
				}
				checks.secretsScope(entry.secrets, `${path}.secrets`);
				validateProfileLinksShape(entry.links, `${path}.links`, checks);
				validateEgressGuardShape(
					entry.egressGuard,
					`${path}.egressGuard`,
					checks,
				);
				if (entry.integrations !== undefined && entry.integrations !== false) {
					validateIntegrationsShape(
						entry.integrations,
						`${path}.integrations`,
						checks,
					);
				}
				if (
					entry.apps === undefined &&
					entry.env === undefined &&
					entry.secrets === undefined &&
					entry.links === undefined &&
					entry.egressGuard === undefined &&
					entry.integrations === undefined
				) {
					errors.push(
						`${path} must set at least one of apps, env, secrets, links, egressGuard, or integrations`,
					);
				}
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
			if (entry.onAppReady !== undefined) {
				if (!strings(entry.onAppReady) || entry.onAppReady.length === 0) {
					errors.push(
						`${path}.onAppReady must be a nonempty array of app names`,
					);
				}
			}
			validateWatchShape(entry.watch, `${path}.watch`, checks);
		}
	}
}

/** `options`, including the `hosts` and `envFile` groups it nests. */
function validateOptionsShape(
	value: Record<string, unknown>,
	checks: ShapeChecks,
): void {
	const { errors, object, record, check, strings, fields, duration } = checks;
	if (!object(value.options)) return;

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

	errors.push(
		...unknownKeyErrors(options, "options", OPTIONS_KEYS, RENAMED_KEYS.options),
	);
	errors.push(...checkoutFileErrors(options.checkoutFiles));
	for (const type of ["boolean", "string"] as const)
		fields(options, "options.", keysChecked(OPTIONS_KEYS, type), type);
	if (options.autoShutdown !== false)
		duration(options.autoShutdown, "options.autoShutdown");
	if (
		options.onAppFailure !== undefined &&
		options.onAppFailure !== "keep-others" &&
		options.onAppFailure !== "stop-run"
	)
		errors.push('options.onAppFailure must be "keep-others" or "stop-run"');

	const hostsOption = options.hosts;
	if (hostsOption !== undefined && typeof hostsOption !== "boolean") {
		if (record(hostsOption, "options.hosts")) {
			errors.push(
				...unknownKeyErrors(
					hostsOption,
					"options.hosts",
					HOSTS_KEYS,
					RENAMED_KEYS["options.hosts"],
				),
			);
			fields(hostsOption, "options.hosts.", ["tld"], "string");
			check(
				hostsOption.services,
				"options.hosts.services",
				hostsOption.services === true || strings(hostsOption.services),
				"true or an array of service names",
			);
		}
	}

	const validateEnvFileEntry = (
		entry: unknown,
		path: string,
	): string | undefined => {
		if (typeof entry === "string") {
			if (entry.trim() === "") {
				errors.push(`${path} must be a nonempty path`);
				return undefined;
			}
			return entry.trim();
		}
		if (!record(entry, path)) return undefined;
		errors.push(...unknownKeyErrors(entry, path, ENV_FILE_KEYS));
		fields(entry, `${path}.`, ["path", "createFrom"], "string");
		fields(entry, `${path}.`, ["values"], "function");
		if (typeof entry.path === "string" && entry.path.trim() === "") {
			errors.push(`${path}.path must be a nonempty path`);
			return undefined;
		}
		return typeof entry.path === "string" ? entry.path.trim() : ".env";
	};

	const envFileOption = options.envFile;
	if (envFileOption !== undefined && typeof envFileOption !== "boolean") {
		if (Array.isArray(envFileOption)) {
			if (envFileOption.length === 0) {
				errors.push(
					"options.envFile must be a nonempty array of paths or envFile options",
				);
			} else {
				const seen = new Set<string>();
				for (const [index, entry] of envFileOption.entries()) {
					const target = validateEnvFileEntry(
						entry,
						`options.envFile.${index}`,
					);
					if (target !== undefined) {
						const normalized = target.replace(/^\.\//, "");
						if (seen.has(normalized)) {
							errors.push(`options.envFile lists "${target}" twice`);
						}
						seen.add(normalized);
					}
				}
			}
		} else {
			validateEnvFileEntry(envFileOption, "options.envFile");
		}
	}
}

function validateLinksShape(value: unknown, checks: ShapeChecks): void {
	const { errors, record, check, strings, fields } = checks;
	if (value === undefined || !record(value, "links")) return;

	for (const [name, entry] of Object.entries(value)) {
		const path = `links.${name}`;
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
			errors.push(`${path} has an invalid name`);
		}
		if (!record(entry, path)) continue;
		errors.push(...unknownKeyErrors(entry, path, LINK_KEYS));
		if (typeof entry.project !== "string" || !entry.project) {
			errors.push(`${path}.project must be a nonempty string`);
		} else if (!/^[a-z][a-z0-9-]*$/.test(entry.project)) {
			errors.push(
				`${path}.project must start with a letter and contain only lowercase letters, numbers, and hyphens`,
			);
		}
		if (entry.path !== undefined) {
			if (typeof entry.path !== "string" || entry.path.trim() === "") {
				errors.push(`${path}.path must be a nonempty string`);
			}
		}
		fields(entry, `${path}.`, ["required"], "boolean");
		check(
			entry.apps,
			`${path}.apps`,
			strings(entry.apps),
			"an array of nonempty strings",
		);
		check(
			entry.services,
			`${path}.services`,
			strings(entry.services),
			"an array of nonempty strings",
		);
		check(
			entry.onChange,
			`${path}.onChange`,
			entry.onChange === "restart" || entry.onChange === "ignore",
			'"restart" or "ignore"',
		);
		if (entry.profile !== undefined) {
			if (typeof entry.profile !== "string" || entry.profile.trim() === "") {
				errors.push(`${path}.profile must be a nonempty string`);
			}
		}
	}
}

function validateProfileLinksShape(
	value: unknown,
	path: string,
	checks: ShapeChecks,
): void {
	const { errors, record, check, strings, fields } = checks;
	if (value === undefined || !record(value, path)) return;

	for (const [name, override] of Object.entries(value)) {
		const entryPath = `${path}.${name}`;
		if (override === false || override === undefined) continue;
		if (!record(override, entryPath)) continue;
		unknownKeys(
			override,
			entryPath,
			["required", "apps", "services", "onChange", "profile"],
			errors,
		);
		fields(override, `${entryPath}.`, ["required"], "boolean");
		check(
			override.apps,
			`${entryPath}.apps`,
			strings(override.apps),
			"an array of nonempty strings",
		);
		check(
			override.services,
			`${entryPath}.services`,
			strings(override.services),
			"an array of nonempty strings",
		);
		check(
			override.onChange,
			`${entryPath}.onChange`,
			override.onChange === "restart" || override.onChange === "ignore",
			'"restart" or "ignore"',
		);
		if (override.profile !== undefined) {
			if (
				typeof override.profile !== "string" ||
				override.profile.trim() === ""
			) {
				errors.push(`${entryPath}.profile must be a nonempty string`);
			}
		}
	}
}

export function validateSupplementShapes(
	value: Record<string, unknown>,
	checks: ShapeChecks,
): void {
	const { errors, check, strings, secretsScope } = checks;
	errors.push(
		...unknownKeyErrors(value, "config", CONFIG_KEYS, RENAMED_KEYS.config),
	);
	secretsScope(value.secrets, "secrets");
	check(
		value.unsetEnv,
		"unsetEnv",
		strings(value.unsetEnv),
		"an array of variable names",
	);
	check(
		value.exportEnv,
		"exportEnv",
		strings(value.exportEnv),
		"an array of variable names",
	);

	validateLinksShape(value.links, checks);
	validateEgressGuardShape(value.egressGuard, "egressGuard", checks);
	validateSectionShapes(value, checks);
	validateListShapes(value, checks);
	validateTypecheckShape(value.typecheck, checks);
	validateCheckShape(value.check, checks);
	validatePredeployShape(value.predeploy, checks);
	validateNamedEntryShapes(value, checks);
	validateOptionsShape(value, checks);
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
	errors.push(...unknownKeyErrors(value, path, known));
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
		["include", "exclude", "concurrency", "groups", "scripts"],
		errors,
	);
	pathList(value.include, "typecheck.include", checks);
	if (
		value.scripts !== undefined &&
		!(strings(value.scripts) && value.scripts.length > 0)
	)
		errors.push("typecheck.scripts must be a nonempty array of script names");
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

/**
 * Step names `check` gives its own steps; a gate with one of them could not
 * be told apart in `--only` and `--skip`.
 */
export const BUILT_IN_CHECK_STEPS = [
	"bun-version",
	"format",
	"biome",
	"docs",
	"typecheck",
	"tests",
] as const;

function validateGatesShape(value: unknown, checks: ShapeChecks): void {
	const { errors, record, fields } = checks;
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		errors.push("check.gates must be an array");
		return;
	}
	const names = new Set<string>();
	for (const [index, gate] of value.entries()) {
		const path = `check.gates.${index}`;
		if (!record(gate, path)) continue;
		unknownKeys(
			gate,
			path,
			["name", "command", "cwd", "when", "staged", "rootWide", "fix", "reuse"],
			errors,
		);
		for (const key of ["name", "command"])
			if (typeof gate[key] !== "string" || !gate[key])
				errors.push(`${path}.${key} must be a nonempty string`);
		fields(gate, `${path}.`, ["cwd", "fix"], "string");
		fields(gate, `${path}.`, ["staged", "rootWide", "reuse"], "boolean");
		pathList(gate.when, `${path}.when`, checks);

		const name = gate.name;
		if (typeof name !== "string" || !name) continue;
		const builtIn = (BUILT_IN_CHECK_STEPS as readonly string[]).includes(name);
		if (builtIn)
			errors.push(
				`${path}.name: "${name}" is a built-in check step; name the gate something else`,
			);
		else if (names.has(name))
			errors.push(`${path}.name: "${name}" is used by an earlier gate`);
		names.add(name);
	}
}

function validateTestAlsoShape(value: unknown, checks: ShapeChecks): void {
	const { errors, record } = checks;
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		errors.push("check.testAlso must be an array");
		return;
	}
	for (const [index, entry] of value.entries()) {
		const path = `check.testAlso.${index}`;
		if (!record(entry, path)) continue;
		unknownKeys(entry, path, ["when", "tests"], errors);
		for (const key of ["when", "tests"]) {
			if (entry[key] === undefined)
				errors.push(`${path}.${key} must be an array of globs`);
			pathList(entry[key], `${path}.${key}`, checks);
		}
	}
}

function validateTestDeferredShape(value: unknown, checks: ShapeChecks): void {
	const { errors, record, fields } = checks;
	if (value === undefined || !record(value, "check.testDeferred")) return;
	unknownKeys(
		value,
		"check.testDeferred",
		["files", "command", "strict"],
		errors,
	);
	if (value.files === undefined)
		errors.push("check.testDeferred.files must be an array of globs");
	pathList(value.files, "check.testDeferred.files", checks);
	fields(value, "check.testDeferred.", ["command"], "string");
	fields(value, "check.testDeferred.", ["strict"], "boolean");
}

/** `check`; shared with `buncargo check`, which reads only this key. */
export function validateCheckShape(value: unknown, checks: ShapeChecks): void {
	const { errors, record, fields } = checks;
	if (value === undefined || !record(value, "check")) return;
	unknownKeys(
		value,
		"check",
		[
			"gates",
			"testCommand",
			"testExclude",
			"testAlso",
			"testDeferred",
			"docs",
			"format",
		],
		errors,
	);
	fields(value, "check.", ["testCommand"], "string");
	const format = value.format;
	if (
		format !== undefined &&
		typeof format !== "boolean" &&
		!(checks.strings(format) && format.length > 0)
	)
		errors.push("check.format must be a boolean or a nonempty array of globs");
	else if (Array.isArray(format)) pathList(format, "check.format", checks);
	validateDocsCheckShape(value.docs, checks);
	pathList(value.testExclude, "check.testExclude", checks);
	validateTestAlsoShape(value.testAlso, checks);
	validateTestDeferredShape(value.testDeferred, checks);
	validateGatesShape(value.gates, checks);
}

/** `predeploy`; shared with `buncargo predeploy`, which reads only this key. */
export function validatePredeployShape(
	value: unknown,
	checks: ShapeChecks,
): void {
	const { errors, record, check, strings, fields, duration } = checks;
	if (value === undefined || !record(value, "predeploy")) return;
	const hooks = ["beforeMigrate", "afterMigrate", "afterSeed", "onFailure"];
	const names = ["environmentVars", "production", "seedIn"];
	unknownKeys(
		value,
		"predeploy",
		[...names, "seed", "retry", ...hooks],
		errors,
	);
	for (const key of names)
		check(
			value[key],
			`predeploy.${key}`,
			strings(value[key]),
			"an array of names",
		);
	check(
		value.seed,
		"predeploy.seed",
		value.seed === true ||
			(typeof value.seed === "string" && value.seed.length > 0),
		"true or a nonempty command",
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
