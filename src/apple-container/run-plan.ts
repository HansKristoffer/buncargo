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

// Compose's substitution rules and the service fingerprint live with the
// compose model, not with one backend: `docker compose` interpolates the file
// itself and this backend has to reproduce it, so a second copy here is a
// second thing to keep in step.
export {
	configHashFor,
	interpolate,
	interpolateNode,
	stableStringify,
} from "../docker-compose/interpolate";

import {
	configHashFor,
	interpolateNode,
	normalizeComposeLabels,
	SERVICE_HASH_LABEL,
} from "../docker-compose/interpolate";
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
	"mem_limit",
	"cpus",
	"env_file",
	"cap_add",
	"cap_drop",
	"init",
	"platform",
	...SILENTLY_DROPPED_KEYS,
]);

export interface ContainerRunPlan {
	serviceName: string;
	containerName: string;
	image: string;
	configHash: string;
	/** Named volumes to create before the run, already project-prefixed. */
	volumes: string[];
	/** Host ports the container publishes, for naming whoever holds one. */
	publishedPorts: number[];
	/** The image platform to pull, so a pull fetches only the one `run` uses. */
	platform: string;
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

/** Apple rejects a longer container ID: it doubles as the hostname. */
const MAX_CONTAINER_NAME_LENGTH = 63;

/**
 * Project names have no length limit (a long worktree name lands in them), so
 * an over-long name keeps its readable head and ends in a hash of the whole,
 * which keeps two long names that share a head apart.
 */
export function containerNameFor(
	projectName: string,
	serviceName: string,
): string {
	const name = sanitizeContainerName(`${projectName}-${serviceName}`);
	if (name.length <= MAX_CONTAINER_NAME_LENGTH) return name;
	const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_CONTAINER_NAME_LENGTH - hash.length - 1)}-${hash}`;
}

/**
 * Named volumes are global to the runtime, so they carry the project name.
 *
 * Not capped like container names: Apple accepts long volume names, and
 * shortening one would hide an existing database behind a new empty volume.
 */
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

/**
 * Compose's two `environment` forms as one record.
 *
 * In the list form a bare `KEY`, and in the map form a `KEY:` with no value,
 * take the value from the environment and are left out when it is unset.
 */
function environmentRecord(
	value: DockerComposeNode | undefined,
	env: Record<string, string>,
): Record<string, string> {
	const entries: [string, string | undefined][] = Array.isArray(value)
		? value.map((entry) => {
				const text = String(entry);
				const at = text.indexOf("=");
				return at < 0
					? [text, env[text]]
					: [text.slice(0, at), text.slice(at + 1)];
			})
		: typeof value === "object" && value !== null
			? Object.entries(value).map(([key, entry]) => [
					key,
					entry === null || entry === undefined ? env[key] : String(entry),
				])
			: [];
	return Object.fromEntries(
		entries.filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}

function field(node: DockerComposeNode, key: string): string | undefined {
	if (typeof node !== "object" || node === null || Array.isArray(node))
		return undefined;
	const value = node[key];
	return value === undefined || value === null || value === ""
		? undefined
		: String(value);
}

/** One `ports` entry as a `--publish` spec, from either compose form. */
function publishSpec(entry: DockerComposeNode, serviceName: string): string {
	if (typeof entry !== "object" || entry === null) return String(entry);
	const target = field(entry, "target");
	const published = field(entry, "published");
	if (!target || !published) {
		throw new Error(
			`Service "${serviceName}" publishes a port without both "target" and "published". Apple container cannot pick a host port; set "published".`,
		);
	}
	const hostIp = field(entry, "host_ip");
	const protocol = field(entry, "protocol");
	return `${hostIp ? `${hostIp}:` : ""}${published}:${target}${protocol ? `/${protocol}` : ""}`;
}

/** The host port of a `--publish` spec: `[ip:]host:container[/proto]`. */
function hostPortOf(spec: string): number | undefined {
	const parts = (spec.split("/")[0] ?? "").split(":");
	if (parts.length < 2) return undefined;
	const port = Number.parseInt(parts.at(-2) ?? "", 10);
	return Number.isFinite(port) ? port : undefined;
}

type MountArgs = { args: string[]; namedVolume?: string };

/** One `volumes` entry as `container run` flags, from either compose form. */
function mountArgs(
	entry: DockerComposeNode,
	context: { projectName: string; serviceName: string; root: string },
): MountArgs {
	const { projectName, serviceName, root } = context;
	const named = (source: string, rest: string): MountArgs => {
		const namedVolume = volumeNameFor(projectName, source);
		return { args: ["--volume", `${namedVolume}:${rest}`], namedVolume };
	};

	if (typeof entry !== "object" || entry === null) {
		const volume = String(entry);
		const separator = volume.indexOf(":");
		// An anonymous volume: Apple creates it implicitly from the target.
		if (separator === -1) return { args: ["--volume", volume] };
		const source = volume.slice(0, separator);
		const rest = volume.slice(separator + 1);
		return isPathSource(source)
			? { args: ["--volume", `${resolvePathSource(source, root)}:${rest}`] }
			: named(source, rest);
	}

	const type = field(entry, "type") ?? "volume";
	const source = field(entry, "source");
	const target = field(entry, "target");
	if (!target) {
		throw new Error(
			`Service "${serviceName}" has a volume with no "target"; Apple container needs to know where to mount it.`,
		);
	}
	const readOnly = !Array.isArray(entry) && entry.read_only === true;
	const rest = readOnly ? `${target}:ro` : target;
	switch (type) {
		case "bind":
			if (!source) break;
			return {
				args: ["--volume", `${resolvePathSource(source, root)}:${rest}`],
			};
		case "volume":
			return source ? named(source, rest) : { args: ["--volume", target] };
		case "tmpfs":
			return { args: ["--tmpfs", target] };
	}
	throw new Error(
		`Service "${serviceName}" has a "${type}" volume${source ? "" : " with no source"}, which Apple container cannot mount. Use docker.runtime: "docker" for it.`,
	);
}

/**
 * Compose's `mem_limit` as Apple's `--memory`.
 *
 * Compose takes bytes or a `b`/`k`/`m`/`g` suffix with an optional trailing
 * `b` (`512mb`); Apple takes a K/M/G suffix and rounds to whole MiB.
 */
function memoryArg(value: DockerComposeNode): string {
	const text = String(value).trim();
	const match = text.match(/^(\d+(?:\.\d+)?)\s*([kmgtp]?)b?$/i);
	if (!match) return text;
	const [, amount = "", unit = ""] = match;
	if (unit) return `${amount}${unit.toUpperCase()}`;
	return `${Math.ceil(Number(amount) / 1024 / 1024)}M`;
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
	// The list form carries buncargo's own labels too: dropping it would leave
	// a container that `down`, `ls` and the sweep cannot find by project.
	const userLabels = asRecord(
		normalizeComposeLabels(service.labels) as DockerComposeNode,
	);
	const configHash = userLabels[SERVICE_HASH_LABEL] || configHashFor(service);
	const labels = { ...userLabels, [CONFIG_HASH_LABEL]: configHash };
	const namedVolumes: string[] = [];
	// `--progress none` keeps the pull and boot progress lines out of the
	// stderr that ends up in an error message.
	const args = [
		"run",
		"--detach",
		"--progress",
		"none",
		"--name",
		containerName,
	];

	const publish = Array.isArray(service.ports)
		? service.ports.map((entry) => publishSpec(entry, serviceName))
		: asStringArray(service.ports);
	for (const spec of publish) {
		args.push("--publish", spec);
	}

	const volumeEntries = Array.isArray(service.volumes)
		? service.volumes
		: service.volumes === undefined
			? []
			: [service.volumes];
	for (const entry of volumeEntries) {
		const mount = mountArgs(entry, { projectName, serviceName, root });
		args.push(...mount.args);
		if (mount.namedVolume) namedVolumes.push(mount.namedVolume);
	}

	// Compose reads env files relative to the compose file's directory; the
	// generated file lives in the root's state, so the root is the user's anchor.
	const envFiles = (
		Array.isArray(service.env_file)
			? service.env_file
			: service.env_file === undefined
				? []
				: [service.env_file]
	).flatMap((entry) => {
		const path =
			typeof entry === "object" ? field(entry, "path") : String(entry);
		return path ? [path] : [];
	});
	for (const path of envFiles) {
		args.push("--env-file", resolvePathSource(path, root));
	}

	for (const [key, value] of Object.entries(
		environmentRecord(service.environment, env),
	)) {
		args.push("--env", `${key}=${value}`);
	}

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
	if (service.init === true) args.push("--init");
	if (service.platform) args.push("--platform", String(service.platform));
	if (service.mem_limit !== undefined)
		args.push("--memory", memoryArg(service.mem_limit));
	// Apple allocates whole CPUs; compose allows fractions.
	if (service.cpus !== undefined)
		args.push("--cpus", String(Math.max(1, Math.ceil(Number(service.cpus)))));
	for (const cap of asStringArray(service.cap_add)) args.push("--cap-add", cap);
	for (const cap of asStringArray(service.cap_drop))
		args.push("--cap-drop", cap);

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
		publishedPorts: publish.flatMap((spec) => {
			const port = hostPortOf(spec);
			return port === undefined ? [] : [port];
		}),
		platform: service.platform ? String(service.platform) : "linux/arm64",
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
