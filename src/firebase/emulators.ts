/**
 * The emulator suite as `firebase-tools` lays it out: which emulators a
 * `firebase.json` starts, their base ports, and the env the CLI hands
 * processes it runs itself (`emulators:exec`). Pure, so the integration's
 * decisions are tested without the CLI.
 */

import { isRecord, recordFromKeys } from "hanzio";

/** Emulators `emulators:start --only` can name. */
export type FirebaseEmulator =
	| "auth"
	| "firestore"
	| "database"
	| "storage"
	| "functions"
	| "pubsub"
	| "hosting"
	| "apphosting"
	| "dataconnect";

/** In the order `firebase-tools` lists them. */
export const FIREBASE_EMULATORS: readonly FirebaseEmulator[] = [
	"apphosting",
	"auth",
	"functions",
	"firestore",
	"database",
	"hosting",
	"pubsub",
	"storage",
	"dataconnect",
];

/**
 * The ports `firebase-tools` falls back to (`emulator/constants.js`), plus the
 * sockets it opens beside an emulator. Eventarc and Cloud Tasks only ever run
 * with the Functions emulator.
 */
export const FIREBASE_DEFAULT_PORTS = {
	ui: 4000,
	hub: 4400,
	logging: 4500,
	hosting: 5000,
	functions: 5001,
	apphosting: 5002,
	firestore: 8080,
	firestoreWebsocket: 9150,
	pubsub: 8085,
	database: 9000,
	auth: 9099,
	storage: 9199,
	eventarc: 9299,
	dataconnect: 9399,
	dataconnectPostgres: 5432,
	tasks: 9499,
} as const;

/** Served by the app `next dev` (or another dev server) already is. */
const APP_SERVING: readonly FirebaseEmulator[] = ["hosting", "apphosting"];

type Json = Record<string, unknown>;

function record(value: unknown): Json {
	return isRecord(value) ? value : {};
}

function emulatorsBlock(raw: Json): Json {
	return record(raw.emulators);
}

function ownPort(value: unknown): number | undefined {
	const port = Number(value);
	return Number.isInteger(port) && port > 0 ? port : undefined;
}

function basePort(block: Json, key: string, fallback: number): number {
	return ownPort(record(block[key]).port) ?? fallback;
}

/**
 * The emulators `firebase emulators:start` would start for this config: each
 * product configured at the top level or under `emulators`. Hosting and App
 * Hosting are left out by default, because they serve the app buncargo
 * already runs.
 */
export function selectEmulators(
	raw: Json,
	only?: readonly FirebaseEmulator[],
): FirebaseEmulator[] {
	if (only) return FIREBASE_EMULATORS.filter((name) => only.includes(name));
	const block = emulatorsBlock(raw);
	return FIREBASE_EMULATORS.filter(
		(name) =>
			!APP_SERVING.includes(name) &&
			(raw[name] !== undefined || block[name] !== undefined),
	);
}

/** Whether the Emulator UI is on; `emulators.ui.enabled: false` turns it off. */
export function uiEnabled(raw: Json): boolean {
	return record(emulatorsBlock(raw).ui).enabled !== false;
}

/**
 * The port the integration's app is given: the Emulator UI, the one a person
 * opens, or the hub when the UI is off. Every other port moves by the same
 * offset.
 */
export function anchorPort(raw: Json): number {
	const block = emulatorsBlock(raw);
	return uiEnabled(raw)
		? basePort(block, "ui", FIREBASE_DEFAULT_PORTS.ui)
		: basePort(block, "hub", FIREBASE_DEFAULT_PORTS.hub);
}

/** Where each started emulator listens in this checkout. */
export interface FirebaseEmulatorPorts {
	host: Partial<Record<FirebaseEmulator, string>>;
	port: Partial<Record<FirebaseEmulator, number>>;
	hub: number;
	logging: number;
	ui?: number;
	firestoreWebsocket?: number;
	eventarc?: number;
	tasks?: number;
	dataconnectPostgres?: number;
}

/**
 * The address a client dials for a configured listen host. A wildcard or
 * `localhost` (which can resolve to `::1` alone) becomes `127.0.0.1`.
 */
function dialHost(host: unknown): string {
	return typeof host === "string" &&
		host &&
		!["0.0.0.0", "::", "localhost"].includes(host)
		? host
		: "127.0.0.1";
}

/** Every port of the selected emulators, moved by this checkout's offset. */
export function emulatorPorts(
	raw: Json,
	selected: readonly FirebaseEmulator[],
	offset: number,
): FirebaseEmulatorPorts {
	const block = emulatorsBlock(raw);
	const at = (key: string, fallback: number) =>
		basePort(block, key, fallback) + offset;
	const has = (name: FirebaseEmulator) => selected.includes(name);
	const firestore = record(block.firestore);
	const dataconnect = record(block.dataconnect);

	return {
		host: recordFromKeys(selected, (name) =>
			dialHost(record(block[name]).host),
		),
		port: recordFromKeys(selected, (name) =>
			at(name, FIREBASE_DEFAULT_PORTS[name]),
		),
		hub: at("hub", FIREBASE_DEFAULT_PORTS.hub),
		logging: at("logging", FIREBASE_DEFAULT_PORTS.logging),
		ui: uiEnabled(raw) ? at("ui", FIREBASE_DEFAULT_PORTS.ui) : undefined,
		firestoreWebsocket: has("firestore")
			? (ownPort(firestore.websocketPort) ??
					FIREBASE_DEFAULT_PORTS.firestoreWebsocket) + offset
			: undefined,
		eventarc: has("functions")
			? at("eventarc", FIREBASE_DEFAULT_PORTS.eventarc)
			: undefined,
		tasks: has("functions")
			? at("tasks", FIREBASE_DEFAULT_PORTS.tasks)
			: undefined,
		dataconnectPostgres: has("dataconnect")
			? (ownPort(dataconnect.postgresPort) ??
					FIREBASE_DEFAULT_PORTS.dataconnectPostgres) + offset
			: undefined,
	};
}

/**
 * Every port the suite listens on except `anchor`, the app's own: what the
 * app declares as `extraPorts`, so the allocator claims and probes them.
 */
export function suitePorts(
	ports: FirebaseEmulatorPorts,
	anchor: number,
): number[] {
	return [
		...Object.values(ports.port),
		ports.hub,
		ports.logging,
		ports.ui,
		ports.firestoreWebsocket,
		ports.eventarc,
		ports.tasks,
		ports.dataconnectPostgres,
	].filter((port): port is number => port !== undefined && port !== anchor);
}

/**
 * `firebase.json` with this checkout's ports.
 *
 * Every port is written out, because the CLI picks a free one for an unset
 * hub, UI, logging or Eventarc port, and nothing could then tell the apps
 * where it went. Listen hosts default to `127.0.0.1`, which the env names.
 */
export function generatedFirebaseConfig(
	raw: Json,
	selected: readonly FirebaseEmulator[],
	ports: FirebaseEmulatorPorts,
): Json {
	const block = emulatorsBlock(raw);
	const emulators: Json = { ...block };
	const listen = (key: string, port: number | undefined, extra: Json = {}) => {
		if (port === undefined) return;
		const own = record(block[key]);
		emulators[key] = { ...own, host: own.host ?? "127.0.0.1", port, ...extra };
	};

	for (const name of selected) listen(name, ports.port[name]);
	listen("hub", ports.hub);
	listen("logging", ports.logging);
	listen("ui", ports.ui);
	listen("eventarc", ports.eventarc);
	listen("tasks", ports.tasks);
	if (ports.firestoreWebsocket !== undefined)
		listen("firestore", ports.port.firestore, {
			websocketPort: ports.firestoreWebsocket,
		});
	if (ports.dataconnectPostgres !== undefined)
		listen("dataconnect", ports.port.dataconnect, {
			postgresPort: ports.dataconnectPostgres,
		});

	return { ...raw, emulators };
}

/**
 * What a process needs to reach the emulators: the variables
 * `firebase emulators:exec` sets (the Admin SDK and Google Cloud clients read
 * them), and `FIREBASE_FUNCTIONS_EMULATOR_HOST` and `FIREBASE_PROJECT_ID` for
 * the web SDK's `connect*Emulator` calls, which read nothing themselves.
 */
export function emulatorEnv(
	selected: readonly FirebaseEmulator[],
	ports: FirebaseEmulatorPorts,
	projectId: string,
): Record<string, string> {
	const address = (name: FirebaseEmulator) =>
		`${ports.host[name]}:${ports.port[name]}`;
	const has = (name: FirebaseEmulator) => selected.includes(name);
	return {
		FIREBASE_PROJECT_ID: projectId,
		GCLOUD_PROJECT: projectId,
		FIREBASE_EMULATOR_HUB: `127.0.0.1:${ports.hub}`,
		...(has("firestore")
			? {
					FIRESTORE_EMULATOR_HOST: address("firestore"),
					FIREBASE_FIRESTORE_EMULATOR_ADDRESS: address("firestore"),
				}
			: {}),
		...(has("auth") ? { FIREBASE_AUTH_EMULATOR_HOST: address("auth") } : {}),
		...(has("database")
			? { FIREBASE_DATABASE_EMULATOR_HOST: address("database") }
			: {}),
		...(has("storage")
			? {
					FIREBASE_STORAGE_EMULATOR_HOST: address("storage"),
					STORAGE_EMULATOR_HOST: `http://${address("storage")}`,
				}
			: {}),
		...(has("pubsub") ? { PUBSUB_EMULATOR_HOST: address("pubsub") } : {}),
		...(has("functions")
			? {
					FIREBASE_FUNCTIONS_EMULATOR_HOST: address("functions"),
					CLOUD_EVENTARC_EMULATOR_HOST: `http://127.0.0.1:${ports.eventarc}`,
					CLOUD_TASKS_EMULATOR_HOST: `127.0.0.1:${ports.tasks}`,
				}
			: {}),
		...(has("dataconnect")
			? {
					FIREBASE_DATA_CONNECT_EMULATOR_HOST: `http://${address("dataconnect")}`,
					DATA_CONNECT_EMULATOR_HOST: address("dataconnect"),
					FIREBASE_DATACONNECT_EMULATOR_HOST: address("dataconnect"),
				}
			: {}),
	};
}

/** The variables browser code needs, for `publicEnvPrefix` copies. */
export const FIREBASE_PUBLIC_ENV = [
	"FIREBASE_PROJECT_ID",
	"FIRESTORE_EMULATOR_HOST",
	"FIREBASE_AUTH_EMULATOR_HOST",
	"FIREBASE_DATABASE_EMULATOR_HOST",
	"FIREBASE_STORAGE_EMULATOR_HOST",
	"FIREBASE_FUNCTIONS_EMULATOR_HOST",
] as const;
