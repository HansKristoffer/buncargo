import { record } from "./client";

/** Public directory fields only; private registry paths, commands and PIDs never travel here. */
export interface RemoteApp {
	name: string;
	status: "starting" | "ready" | "reused" | "stopped" | "failed";
	url: string;
}

export interface RemoteRun {
	id: string;
	project: string;
	worktree?: string | null;
	branch?: string | null;
	apps: RemoteApp[];
}

export interface RemoteDirectory {
	version: 1;
	machineId: string;
	hostname: string;
	generatedAt: string;
	runs: RemoteRun[];
}

const statuses = new Set(["starting", "ready", "reused", "stopped", "failed"]);

const label = (v: unknown): v is string =>
	typeof v === "string" && v.length <= 256;

const optionalLabel = (v: unknown): v is string | null | undefined =>
	v == null || label(v);

/** The network schema is independent of the private run registry. */
export function parseRemoteDirectory(
	value: unknown,
	host: string,
	expectedID?: string,
	now = Date.now(),
): RemoteDirectory {
	const v = record(value);

	if (v.version !== 1)
		throw new Error("Unsupported remote directory version; update buncargo");

	// Bind the response to the requested peer and reject stale or oversized snapshots.
	if (
		v.hostname !== host ||
		typeof v.machineId !== "string" ||
		!v.machineId ||
		v.machineId.length > 256 ||
		(expectedID !== undefined && v.machineId !== expectedID) ||
		typeof v.generatedAt !== "string" ||
		!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.generatedAt) ||
		!(Math.abs(Date.parse(v.generatedAt) - now) < 120000) ||
		!Array.isArray(v.runs) ||
		v.runs.length > 250
	)
		throw new Error("Invalid or stale remote directory");

	const runs: RemoteRun[] = v.runs.map((value) => {
		const run = record(value);

		if (
			!label(run.id) ||
			!run.id ||
			!label(run.project) ||
			!optionalLabel(run.worktree) ||
			!optionalLabel(run.branch) ||
			!Array.isArray(run.apps) ||
			run.apps.length > 100
		)
			throw new Error("Invalid remote run");

		const apps: RemoteApp[] = run.apps.map((value) => {
			const app = record(value);

			if (
				!label(app.name) ||
				!app.name ||
				typeof app.status !== "string" ||
				!statuses.has(app.status) ||
				typeof app.url !== "string" ||
				app.url.length > 2048
			)
				throw new Error("Invalid remote app");

			// Remote entries may open only this machine's private app ports.
			const url = new URL(app.url);

			if (
				url.protocol !== "https:" ||
				url.hostname !== host ||
				url.username ||
				url.password ||
				Number(url.port) < 20000 ||
				Number(url.port) > 29999
			)
				throw new Error("Invalid remote app URL");

			return {
				name: app.name,
				status: app.status as RemoteApp["status"],
				url: app.url,
			};
		});

		// App names identify rows within a run; duplicate names would make updates ambiguous.
		if (new Set(apps.map((a) => a.name)).size !== apps.length)
			throw new Error("Duplicate remote app");

		return {
			id: run.id,
			project: run.project,
			worktree: run.worktree,
			branch: run.branch,
			apps,
		};
	});

	if (new Set(runs.map((r) => r.id)).size !== runs.length)
		throw new Error("Duplicate remote run");

	return {
		version: 1,
		machineId: v.machineId,
		hostname: host,
		generatedAt: v.generatedAt,
		runs,
	};
}
