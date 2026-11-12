import { readEnvOverrides } from "../../core/env-overrides";
import { BASE_EXITS, defineCommand, defineGroup } from "../command-spec";
import { CliError } from "../errors";
import type { EnvJson } from "../json-documents";
import * as log from "../log";
import { envSetCommand, envUnsetCommand } from "./env-set";
import { loadLiveEnv } from "./load-env";

export function getEnvDotPath(snapshot: object, path: string): unknown {
	let current: unknown = snapshot;
	for (const part of path.split(".").filter(Boolean)) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** `export NAME='value'` lines a shell can `eval`, quoted so nothing expands. */
export function formatEnvExports(vars: Record<string, string>): string {
	return Object.entries(vars)
		.map(
			([name, value]) => `export ${name}='${value.replaceAll("'", "'\\''")}'`,
		)
		.join("\n");
}

export function formatEnvDotValue(value: unknown): string {
	if (value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return JSON.stringify(value);
}

async function readEnvJson(): Promise<EnvJson> {
	const env = await loadLiveEnv();
	return {
		projectName: env.projectName,
		ports: env.ports as Record<string, number>,
		urls: env.urls as Record<string, string>,
		loopbackUrls: env.loopbackUrls as Record<string, string>,
		portOffset: env.portOffset,
		portOffsetProvenance: env.portOffsetProvenance,
		isWorktree: env.isWorktree,
		localIp: env.localIp,
		root: env.root,
		captured: env.captured as Record<string, string>,
		details: env.details() as Record<string, unknown>,
		hosts: env.hosts
			? {
					active: env.hosts.active,
					mode: env.hosts.mode,
					tld: env.hosts.tld,
					plan: env.hosts.plan,
					tailscaleUrls: env.hosts.tailscaleUrls,
				}
			: null,
		// What `exec`, tasks and the apps are given (without their secrets),
		// so `DATABASE_URL` can be read rather than reassembled from ports.
		vars: env.buildEnvVars() as Record<string, string>,
		// `buncargo env set` keys, already applied to `vars`.
		overrides: Object.keys(readEnvOverrides(env.root)),
	} satisfies EnvJson;
}

const envShowCommand = defineCommand({
	spec: {
		name: "env",
		summary: "Print environment info as JSON, including injected vars",
		flags: {
			get: {
				kind: "string",
				value: "<path>",
				description:
					"Print one value: a dot path (ports.api, urls.web) or a variable (DATABASE_URL)",
			},
			export: {
				kind: "boolean",
				description:
					'Injected vars as shell exports: eval "$(buncargo env --export)"',
			},
		},
	},
	exits: BASE_EXITS,
	json: "EnvJson",
	run: async ({ values }) => {
		if (values.get !== undefined && values.export)
			throw new CliError("Choose either --get or --export, not both.");
		const snapshot = await readEnvJson();
		if (values.export) {
			log.line(formatEnvExports(snapshot.vars));
			return 0;
		}
		const path = values.get;
		if (path !== undefined) {
			// A bare variable name (`--get DATABASE_URL`) reads from `vars`.
			const value =
				getEnvDotPath(snapshot, path) ??
				(path.includes(".") ? undefined : snapshot.vars[path]);
			if (value === undefined) throw new CliError(`Unknown env path: ${path}`);
			log.line(formatEnvDotValue(value));
			return 0;
		}
		log.line(JSON.stringify(snapshot, null, 2));
		return 0;
	},
});

export const envCommand = defineGroup({
	spec: {
		name: "env",
		usage: "env [options] | env set|unset",
		summary: "Print environment info as JSON, or override a variable",
	},
	subcommands: { set: envSetCommand, unset: envUnsetCommand },
	fallback: envShowCommand,
});
