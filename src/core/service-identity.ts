import type { DockerPresetName, ServiceConfig } from "../types";
import { isHttpService } from "./hosts/plan";
import { inferDockerPreset } from "./service-presets";

/**
 * What a service *is*, for every consumer that has to treat one specially.
 *
 * The startup banner decided a service was Postgres with
 * `name.toLowerCase().includes("postgres")`, so a service keyed `db` got no
 * TablePlus link even though the compose side already knew its preset from
 * `service.postgres()`. The named-hosts planner asked a third question
 * (`isHttpService`) somewhere else again. The run registry and the menu bar
 * need all of it at once, so it is answered once here.
 */

export interface ServiceIdentity {
	name: string;
	/** The built-in preset backing it, or `undefined` for a custom service. */
	preset: DockerPresetName | undefined;
	/** Worth opening in a browser: gets an `↗` in the UI and a named host. */
	http: boolean;
	/** Openable in TablePlus — currently the SQL presets. */
	database: boolean;
	/** TablePlus deeplink, only when {@link database}. */
	tablePlusUrl?: string;
}

/** Presets a GUI database client can open. */
const DATABASE_PRESETS = new Set<DockerPresetName>(["postgres", "clickhouse"]);

interface Credentials {
	user: string;
	password: string;
	database: string;
}

const PRESET_CREDENTIALS: Partial<Record<DockerPresetName, Credentials>> = {
	postgres: { user: "postgres", password: "postgres", database: "postgres" },
	clickhouse: { user: "default", password: "clickhouse", database: "default" },
};

/**
 * TablePlus connection URL.
 *
 * Do not set `schema` with `name` — that pair is the table-filter deeplink.
 */
export function tablePlusUrl(input: {
	user: string;
	password: string;
	port: number;
	database: string;
	name: string;
	scheme?: string;
}): string {
	const url = new URL(`${input.scheme ?? "postgresql"}://127.0.0.1`);
	url.port = String(input.port);
	url.username = input.user;
	url.password = input.password;
	url.pathname = `/${encodeURIComponent(input.database)}`;
	url.search = [
		["env", "development"],
		["name", input.name],
		["tLSMode", "0"],
	]
		.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
		.join("&");
	return url.toString();
}

export function describeService(input: {
	name: string;
	service: ServiceConfig | undefined;
	port: number | undefined;
	/** Disambiguates the saved connection when several projects run at once. */
	projectName?: string;
}): ServiceIdentity {
	const { name, service, port, projectName } = input;
	const preset = inferDockerPreset(name, service);
	const identity: ServiceIdentity = {
		name,
		preset,
		http: service ? isHttpService(name, service) : false,
		database: preset !== undefined && DATABASE_PRESETS.has(preset),
	};

	if (!identity.database || preset === undefined || port === undefined) {
		return identity;
	}

	const defaults = PRESET_CREDENTIALS[preset];
	const config = service as
		| { database?: string; user?: string; password?: string }
		| undefined;
	identity.tablePlusUrl = tablePlusUrl({
		user: config?.user ?? defaults?.user ?? "",
		password: config?.password ?? defaults?.password ?? "",
		port,
		database: config?.database ?? defaults?.database ?? "",
		name: projectName ? `${projectName}-${name}` : name,
		// ClickHouse speaks its own scheme to TablePlus; everything else here
		// is Postgres-compatible.
		scheme: preset === "clickhouse" ? "clickhouse" : "postgresql",
	});
	return identity;
}
