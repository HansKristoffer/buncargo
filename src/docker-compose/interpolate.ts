import { createHash } from "node:crypto";
import type {
	ComposeDocument,
	DockerComposeNode,
	DockerComposeServiceRaw,
} from "../types";

/**
 * Compose's own `${VAR}` substitution, and the fingerprint built on top of it.
 *
 * This is compose semantics, not one backend's: `docker compose` interpolates
 * the file before running it and the generated model depends on that, while the
 * Apple backend has to do the substitution itself. Both read the same rules
 * from here so they cannot disagree about what a service definition means.
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
export function interpolateNode(
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

export function stableStringify(value: unknown): string {
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
 * the second case. Only buncargo hash labels are excluded to avoid a self-reference. User labels remain part of the definition.
 */
export function normalizeComposeLabels(
	labels: DockerComposeServiceRaw["labels"],
): Record<string, DockerComposeNode | undefined> {
	if (Array.isArray(labels))
		return Object.fromEntries(
			labels.map((entry) => {
				const text = String(entry);
				const at = text.indexOf("=");
				return at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + 1)];
			}),
		);
	return typeof labels === "object" && labels !== null ? labels : {};
}

function withoutHashLabels(
	service: DockerComposeServiceRaw,
	preserveSyntax = false,
): DockerComposeServiceRaw {
	const { labels, ...rest } = service;
	if (preserveSyntax && Array.isArray(labels)) {
		return {
			...rest,
			labels: labels.filter(
				(entry) =>
					![
						STACK_HASH_LABEL,
						SERVICE_HASH_LABEL,
						"buncargo.config-hash",
					].includes(String(entry).split("=")[0] ?? ""),
			),
		};
	}
	const userLabels = Object.fromEntries(
		Object.entries(normalizeComposeLabels(labels)).filter(
			([key]) =>
				![
					STACK_HASH_LABEL,
					SERVICE_HASH_LABEL,
					"buncargo.config-hash",
				].includes(key),
		),
	);
	return {
		...rest,
		...(Object.keys(userLabels).length ? { labels: userLabels } : {}),
	};
}

export function configHashFor(service: DockerComposeServiceRaw): string {
	return createHash("sha256")
		.update(stableStringify(withoutHashLabels(service)))
		.digest("hex")
		.slice(0, 16);
}

/** Label carrying the fingerprint of the whole stack a run would create. */
export const STACK_HASH_LABEL = "buncargo.stack-hash";

/**
 * Environment variable the generated model reads the stack hash from.
 *
 * The hash cannot be baked into the file: it depends on the interpolated
 * values, which are only known once ports have been allocated, and the file is
 * written before that is handed to a backend. Writing a `${...}` reference
 * instead means both backends pick it up through the substitution they already
 * do.
 */
export const STACK_HASH_ENV = "BUNCARGO_STACK_HASH";

/**
 * Fingerprint the services a run is about to bring up, as they will actually
 * be created.
 *
 * Interpolated first, so a port block that moved changes the hash even though
 * the file text did not. Only hash labels are excluded, as in {@link configHashFor}.
 *
 * The whole selected stack rather than one service, because the only question
 * it answers is whether this run needs to reconcile at all.
 */
export function projectStackHash(input: {
	model: ComposeDocument;
	envVars: Record<string, string>;
	serviceNames: string[];
}): string {
	const services = [...input.serviceNames].sort().map((name) => {
		const service = input.model.services?.[name];
		if (!service) return `${name}:absent`;
		const interpolated = interpolateNode(
			service as DockerComposeNode,
			input.envVars,
		) as DockerComposeServiceRaw;
		return `${name}:${configHashFor(interpolated)}`;
	});
	return createHash("sha256")
		.update(services.join("\n"))
		.digest("hex")
		.slice(0, 16);
}

/** Per-service identity is independent of the selected app/service subset. */
export const SERVICE_HASH_LABEL = "buncargo.service-hash";
export function serviceHashEnv(name: string): string {
	return `BUNCARGO_SERVICE_HASH_${createHash("sha256").update(name).digest("hex").slice(0, 16).toUpperCase()}`;
}

export function serviceFingerprint(
	model: ComposeDocument,
	name: string,
	env: Record<string, string>,
): string {
	const service = model.services?.[name];
	if (!service)
		throw new Error(`Service ${name} is missing from the Compose model`);
	const interpolated = interpolateNode(
		service as DockerComposeNode,
		env,
	) as DockerComposeServiceRaw;
	const volumes: Record<string, unknown> = {};
	for (const mount of interpolated.volumes ?? []) {
		const source =
			typeof mount === "string"
				? mount.split(":")[0]
				: (mount as Record<string, unknown>).source;
		if (typeof source === "string" && model.volumes?.[source])
			volumes[source] = interpolateNode(
				model.volumes[source] as DockerComposeNode,
				env,
			);
	}
	return createHash("sha256")
		.update(stableStringify({ service: configHashFor(interpolated), volumes }))
		.digest("hex")
		.slice(0, 16);
}

/** External build/config inputs are deliberately reconciled on every invocation. */
export function canProveServiceUnchanged(
	service: DockerComposeServiceRaw,
): boolean {
	if (
		["build", "env_file", "extends", "configs", "secrets", "label_file"].some(
			(key) => service[key] !== undefined,
		)
	)
		return false;
	// An explicit refresh policy is work the backend must perform even when
	// the generated definition did not change. Latest/default tags also use it.
	if (
		service.pull_policy !== undefined &&
		!["never", "missing", "if_not_present"].includes(
			String(service.pull_policy),
		)
	)
		return false;
	const image = service.image;
	if (image && !image.includes("@") && service.pull_policy !== "never") {
		const basename = image.slice(image.lastIndexOf("/") + 1);
		if (!basename.includes(":") || basename.endsWith(":latest")) return false;
	}
	return true;
}

/** A warm shortcut needs complete inputs and interpolation syntax we understand. */
export function canProveServiceInputs(
	model: ComposeDocument,
	name: string,
	env: Record<string, string>,
): boolean {
	const service = model.services[name];
	if (!service || !canProveServiceUnchanged(service)) return false;
	const nodes: unknown[] = [withoutHashLabels(service, true)];
	// Top-level volume settings can themselves reference Compose's implicit .env.
	for (const mount of service.volumes ?? []) {
		const rawSource =
			typeof mount === "string"
				? mount.split(":")[0]
				: (mount as Record<string, unknown>).source;
		if (typeof rawSource !== "string") continue;
		const source = interpolate(rawSource, env);
		if (model.volumes?.[source]) nodes.push(model.volumes[source]);
	}
	function complete(node: unknown): boolean {
		if (Array.isArray(node)) return node.every(complete);
		if (typeof node === "object" && node !== null)
			return Object.values(node).every(complete);
		if (typeof node !== "string") return true;
		let known = true;
		const remainder = node.replace(
			INTERPOLATION_PATTERN,
			(
				match,
				braced: string | undefined,
				_operator: string | undefined,
				argument: string | undefined,
				bare: string | undefined,
			) => {
				if (match === "$$") return "";
				const variable = braced ?? bare;
				if (!variable || env[variable] === undefined || argument?.includes("$"))
					known = false;
				return "";
			},
		);
		// Unsupported operators and nested substitutions must go through Compose.
		return known && !remainder.includes("$");
	}
	return nodes.every(complete);
}
