import type {
	DockerPresetName,
	ResolvedService,
	ServiceCredentials,
} from "../types";
import { isHttpService } from "./hosts/plan";

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

/** A preset's user, password and database. */
export type Credentials = ServiceCredentials;

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

/**
 * A Postgres service's credentials. Every service whose preset is Postgres
 * resolves them; a custom container a caller took for one gets the image's.
 */
export function postgresCredentials(
	service: ResolvedService | undefined,
): Credentials {
	return (
		service?.credentials ?? {
			user: "postgres",
			password: "postgres",
			database: "postgres",
		}
	);
}

export function describeService(input: {
	name: string;
	service: ResolvedService | undefined;
	port: number | undefined;
	/** Disambiguates the saved connection when several projects run at once. */
	projectName?: string;
}): ServiceIdentity {
	const { name, service, port, projectName } = input;
	const preset = service?.preset;
	const identity: ServiceIdentity = {
		name,
		preset,
		http: service ? isHttpService(service) : false,
		database: preset !== undefined && DATABASE_PRESETS.has(preset),
	};

	const credentials = service?.credentials;
	if (!identity.database || !credentials || port === undefined) {
		return identity;
	}

	identity.tablePlusUrl = tablePlusUrl({
		user: credentials.user,
		password: credentials.password,
		port,
		database: credentials.database,
		name: projectName ? `${projectName}-${name}` : name,
		// ClickHouse speaks its own scheme to TablePlus; everything else here
		// is Postgres-compatible.
		scheme: preset === "clickhouse" ? "clickhouse" : "postgresql",
	});
	return identity;
}
