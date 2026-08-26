import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ComposeDocument } from "../docker-compose";
import type { DockerComposeNode, DockerComposeServiceRaw } from "../types";

/**
 * Translate the generated compose model into Apple `container` invocations.
 *
 * Apple's CLI has no compose equivalent, so this is where a compose service
 * becomes one `container run`. Everything here is pure: the caller executes the
 * argv arrays, which keeps the whole translation unit-testable without a
 * container runtime present.
 */

/** Label carrying the immutable part of a service's config. */
export const CONFIG_HASH_LABEL = "buncargo.config-hash";
export const PROJECT_LABEL = "buncargo.project";
export const SERVICE_LABEL = "buncargo.service";

/**
 * Compose keys dropped without a warning.
 *
 * Silently dropping a key a user wrote by hand is the worst outcome here, so
 * anything outside this set is reported. These three are the exceptions, all
 * because the preset builders emit them on every service: warning about them
 * would fire on every run and teach people to ignore the warning that matters.
 *
 * - `healthcheck`: buncargo polls the published port itself, so dropping the
 *   compose probe changes nothing observable.
 * - `depends_on`: honored, just as start order rather than as a condition.
 * - `restart`: buncargo owns the container lifecycle, starting them per `dev`
 *   run and stopping them from the watchdog, so a restart policy is not part of
 *   the contract either backend offers.
 */
const SILENTLY_DROPPED_KEYS = new Set(["healthcheck", "depends_on", "restart"]);

/**
 * `container_name` is deliberately absent: the container is always named
 * `<project>-<service>` so exec, reuse and teardown all agree on one name
 * without threading a second one through. A user who sets it gets the warning
 * rather than a silently ignored key.
 */
const TRANSLATED_KEYS = new Set([
	"image",
	"ports",
	"volumes",
	"environment",
	"command",
	"entrypoint",
	"working_dir",
	"labels",
	"ulimits",
	"user",
	"tmpfs",
	"read_only",
	"shm_size",
	...SILENTLY_DROPPED_KEYS,
]);

export interface ContainerRunPlan {
	serviceName: string;
	containerName: string;
	image: string;
	configHash: string;
	/** Named volumes to create before the run, already project-prefixed. */
	volumes: string[];
	/** Full `container` argv, excluding the binary itself. */
	runArgs: string[];
}

export interface AppleRunPlan {
	projectName: string;
	services: ContainerRunPlan[];
	/** Every project-prefixed named volume the plan touches. */
	volumes: string[];
	/** Compose keys that were dropped, for a single warning by the caller. */
	unsupportedKeys: string[];
}

/**
 * Apple container IDs accept `[a-zA-Z0-9_.-]` and must start alphanumerically.
 */
export function sanitizeContainerName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9_.-]/g, "-");
	return /^[a-zA-Z0-9]/.test(sanitized) ? sanitized : `c-${sanitized}`;
}

export function containerNameFor(
	projectName: string,
	serviceName: string,
): string {
	return sanitizeContainerName(`${projectName}-${serviceName}`);
}

/** Named volumes are global to the runtime, so they carry the project name. */
export function volumeNameFor(projectName: string, volume: string): string {
	return sanitizeContainerName(`${projectName}-${volume}`);
}

/**
 * Every form compose substitutes, matched in one pass.
 *
 * One pass rather than one per form is what makes `$$` an escape: it is
 * consumed here, so the `$` it produces can never be re-read as the start of a
 * reference by a later pass.
 */
const INTERPOLATION_PATTERN =
	/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Apply compose's `${VAR}` substitution forms.
 *
 * `docker compose` interpolates the file before running it, and the generated
 * model relies on that: port bindings are written as `${POSTGRES_PORT:-5432}`.
 * Apple's CLI does no substitution, so leaving it out would publish a literal
 * `${POSTGRES_PORT:-5432}` and fail on every preset.
 *
 * The colon is the difference between "unset or empty" and "unset only", and
 * compose treats the two apart: `${VAR:-d}` replaces an empty value, `${VAR-d}`
 * keeps it. Collapsing them would silently substitute a default over a variable
 * the user deliberately set to empty.
 */
export function interpolate(
	value: string,
	env: Record<string, string>,
): string {
	return value.replace(
		INTERPOLATION_PATTERN,
		(
			match,
			braced: string | undefined,
			operator: string | undefined,
			argument: string | undefined,
			bare: string | undefined,
		) => {
			if (match === "$$") return "$";
			// Compose substitutes an unset bare `$VAR` with the empty string.
			if (bare !== undefined) return env[bare] ?? "";

			const name = braced as string;
			const found = env[name];
			if (operator === undefined) return found ?? "";

			const colon = operator.startsWith(":");
			const missing = colon
				? found === undefined || found === ""
				: found === undefined;

			if (operator.endsWith("?")) {
				if (missing) {
					throw new Error(
						`Required variable ${name} is ${found === undefined ? "not set" : "empty"}${
							argument ? `: ${argument}` : ""
						}`,
					);
				}
				return found as string;
			}

			return missing ? (argument ?? "") : (found as string);
		},
	);
}

/** Interpolate every string in a compose node, the way the YAML path does. */
function interpolateNode(
	node: DockerComposeNode,
	env: Record<string, string>,
): DockerComposeNode {
	if (typeof node === "string") return interpolate(node, env);
	if (Array.isArray(node)) {
		return node.map((entry) => interpolateNode(entry, env));
	}
	if (typeof node === "object" && node !== null) {
		const result: Record<string, DockerComposeNode> = {};
		for (const [key, value] of Object.entries(node)) {
			if (value === undefined) continue;
			result[key] = interpolateNode(value, env);
		}
		return result;
	}
	return node;
}

function isPathSource(source: string): boolean {
	return (
		source.startsWith("/") ||
		source.startsWith("./") ||
		source.startsWith("../") ||
		source.startsWith("~")
	);
}

/**
 * A bind-mount source as an absolute host path.
 *
 * `~` is expanded here rather than left to `resolve`, which would treat it as
 * an ordinary directory name and mount a literal `~` folder under the project.
 */
function resolvePathSource(source: string, root: string): string {
	if (source === "~" || source.startsWith("~/")) {
		return resolve(homedir(), source.slice(1).replace(/^\//, ""));
	}
	return isAbsolute(source) ? source : resolve(root, source);
}

function asStringArray(value: DockerComposeNode | undefined): string[] {
	if (value === undefined) return [];
	if (Array.isArray(value)) return value.map((entry) => String(entry));
	return [String(value)];
}

function asRecord(
	value: DockerComposeNode | undefined,
): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry === undefined || entry === null) continue;
		if (typeof entry === "object") continue;
		record[key] = String(entry);
	}
	return record;
}

/**
 * Split a command line into words the way a shell would.
 *
 * Compose splits the string form of `command` / `entrypoint` with shell word
 * rules, so quotes group and backslashes escape. Splitting on whitespace alone
 * turns `sh -c "echo hi"` into four arguments and `--flag="a b"` into two
 * broken ones, neither of which the image can parse.
 */
export function splitCommandLine(value: string): string[] {
	const words: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;

	for (let i = 0; i < value.length; i++) {
		const char = value[i] as string;

		if (quote === "'") {
			// Single quotes are literal: even a backslash carries no meaning.
			if (char === "'") quote = undefined;
			else current += char;
			continue;
		}

		if (char === "\\") {
			const next = value[i + 1];
			// A trailing backslash has nothing to escape, so it stays literal.
			if (next === undefined) {
				current += char;
				continue;
			}
			// Inside double quotes a backslash only escapes these four.
			if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) {
				current += char;
				continue;
			}
			current += next;
			started = true;
			i++;
			continue;
		}

		if (quote === '"') {
			if (char === '"') quote = undefined;
			else current += char;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			// An empty "" is still a word, so remember we opened one.
			started = true;
			continue;
		}

		if (/\s/.test(char)) {
			if (started || current) {
				words.push(current);
				current = "";
				started = false;
			}
			continue;
		}

		current += char;
		started = true;
	}

	if (started || current) words.push(current);
	return words;
}

/**
 * Compose's two `command` / `entrypoint` forms as one argv.
 *
 * The list form is already argv. The string form is a command line, which
 * compose splits into words - passing it through as a single argument would
 * hand the image one long argument it cannot parse. The typesense preset
 * writes the string form, so this is the difference between it starting and
 * printing its usage.
 */
function commandWords(value: DockerComposeNode | undefined): string[] {
	if (typeof value === "string") {
		return splitCommandLine(value);
	}
	return asStringArray(value);
}

function ulimitArgs(value: DockerComposeNode | undefined): string[] {
	const args: string[] = [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return args;
	}
	for (const [name, limit] of Object.entries(value)) {
		if (typeof limit === "number") {
			args.push("--ulimit", `${name}=${limit}`);
			continue;
		}
		if (typeof limit === "object" && limit !== null && !Array.isArray(limit)) {
			const soft = (limit as Record<string, unknown>).soft;
			const hard = (limit as Record<string, unknown>).hard;
			if (soft !== undefined && hard !== undefined) {
				args.push("--ulimit", `${name}=${soft}:${hard}`);
			}
		}
	}
	return args;
}

/**
 * Order services so a dependency starts before its dependents.
 *
 * Compose `depends_on` conditions cannot be honored (Apple surfaces no health
 * state), so only the edge is used. A cycle falls back to declaration order
 * rather than throwing: refusing to start is worse than starting in the order
 * the user wrote.
 */
export function orderServices(
	services: Record<string, DockerComposeServiceRaw>,
): string[] {
	const names = Object.keys(services);
	const ordered: string[] = [];
	const state = new Map<string, "visiting" | "done">();

	function visit(name: string): void {
		const current = state.get(name);
		if (current === "done" || current === "visiting") return;
		state.set(name, "visiting");
		const dependsOn = services[name]?.depends_on;
		const dependencies = Array.isArray(dependsOn)
			? dependsOn.map(String)
			: typeof dependsOn === "object" && dependsOn !== null
				? Object.keys(dependsOn)
				: [];
		for (const dependency of dependencies) {
			if (services[dependency]) visit(dependency);
		}
		state.set(name, "done");
		ordered.push(name);
	}

	for (const name of names) visit(name);
	return ordered;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * Fingerprint the parts of a service that cannot change on a running container.
 *
 * Recorded as a label so a later run can tell "this container is mine and
 * still matches" from "the config changed underneath it", and recreate only in
 * the second case. Labels themselves are excluded: the hash is one of them.
 */
export function configHashFor(service: DockerComposeServiceRaw): string {
	const { labels: _labels, ...rest } = service;
	return createHash("sha256")
		.update(stableStringify(rest))
		.digest("hex")
		.slice(0, 16);
}

function buildServicePlan(
	projectName: string,
	serviceName: string,
	raw: DockerComposeServiceRaw,
	root: string,
	env: Record<string, string>,
	unsupportedKeys: Set<string>,
): ContainerRunPlan {
	const service = interpolateNode(raw, env) as DockerComposeServiceRaw;
	const image = service.image;
	if (!image) {
		throw new Error(
			`Service "${serviceName}" has no image. Apple container cannot build a service without one; add an image or use the docker runtime.`,
		);
	}

	const containerName = containerNameFor(projectName, serviceName);
	const configHash = configHashFor(service);
	const namedVolumes: string[] = [];
	const args = ["run", "--detach", "--name", containerName];

	for (const port of asStringArray(service.ports)) {
		args.push("--publish", port);
	}

	for (const volume of asStringArray(service.volumes)) {
		const separator = volume.indexOf(":");
		if (separator === -1) {
			// An anonymous volume: Apple creates it implicitly from the target.
			args.push("--volume", volume);
			continue;
		}
		const source = volume.slice(0, separator);
		const rest = volume.slice(separator + 1);
		if (isPathSource(source)) {
			args.push("--volume", `${resolvePathSource(source, root)}:${rest}`);
			continue;
		}
		const named = volumeNameFor(projectName, source);
		namedVolumes.push(named);
		args.push("--volume", `${named}:${rest}`);
	}

	for (const [key, value] of Object.entries(asRecord(service.environment))) {
		args.push("--env", `${key}=${value}`);
	}

	const labels = {
		...asRecord(service.labels),
		[CONFIG_HASH_LABEL]: configHash,
	};
	for (const [key, value] of Object.entries(labels)) {
		args.push("--label", `${key}=${value}`);
	}

	args.push(...ulimitArgs(service.ulimits));

	for (const path of asStringArray(service.tmpfs)) {
		args.push("--tmpfs", path);
	}

	if (service.working_dir) args.push("--workdir", String(service.working_dir));
	if (service.user) args.push("--user", String(service.user));
	if (service.shm_size) args.push("--shm-size", String(service.shm_size));
	if (service.read_only === true) args.push("--read-only");

	// Apple's `--entrypoint` takes one command, so compose's list form splits:
	// the head is the executable, the tail is prepended to the container's
	// arguments the way compose prepends it to `command`.
	const [executable, ...entrypointArgs] = commandWords(service.entrypoint);
	if (executable !== undefined) args.push("--entrypoint", executable);

	for (const key of Object.keys(service)) {
		if (!TRANSLATED_KEYS.has(key) && service[key] !== undefined) {
			unsupportedKeys.add(key);
		}
	}

	args.push(image, ...entrypointArgs, ...commandWords(service.command));

	return {
		serviceName,
		containerName,
		image,
		configHash,
		volumes: namedVolumes,
		runArgs: args,
	};
}

export interface BuildAppleRunPlanOptions {
	projectName: string;
	model: ComposeDocument;
	root: string;
	/** Values for `${VAR}` substitution, as compose would receive them. */
	env?: Record<string, string>;
	/** Compose service names to include; omit for every service in the model. */
	serviceNames?: string[];
}

export function buildAppleRunPlan(
	options: BuildAppleRunPlanOptions,
): AppleRunPlan {
	const { projectName, model, root, env = {}, serviceNames } = options;
	const wanted = serviceNames ? new Set(serviceNames) : null;
	const unsupportedKeys = new Set<string>();

	const services = orderServices(model.services)
		.filter((name) => !wanted || wanted.has(name))
		.map((name) => {
			const service = model.services[name];
			if (!service) {
				throw new Error(`Service "${name}" is not in the generated model`);
			}
			return buildServicePlan(
				projectName,
				name,
				service,
				root,
				env,
				unsupportedKeys,
			);
		});

	const volumes = Array.from(
		new Set(services.flatMap((service) => service.volumes)),
	);

	return {
		projectName,
		services,
		volumes,
		unsupportedKeys: Array.from(unsupportedKeys).sort(),
	};
}

/** Every project-prefixed named volume declared by the model. */
export function projectVolumeNames(
	projectName: string,
	model: ComposeDocument,
): string[] {
	return Object.keys(model.volumes ?? {}).map((volume) =>
		volumeNameFor(projectName, volume),
	);
}
