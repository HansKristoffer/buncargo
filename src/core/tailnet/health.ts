import { record } from "./client";
import { DIRECTORY_LOCAL_PORT } from "./state";

export interface TailnetHealth {
	service: "buncargo-tailnet";
	version: 1;
	bundleHash?: string;
	ready: boolean;
	lastSuccess?: string;
	issues: string[];
}

export async function readTailnetHealth(
	request: typeof fetch = fetch,
): Promise<TailnetHealth | undefined> {
	try {
		const response = await request(
			`http://127.0.0.1:${DIRECTORY_LOCAL_PORT}/health`,
			{ signal: AbortSignal.timeout(1000), redirect: "error" },
		);

		const value = record(await response.json());

		if (
			!response.ok ||
			value.service !== "buncargo-tailnet" ||
			value.version !== 1
		)
			return undefined;

		return {
			service: "buncargo-tailnet",
			version: 1,
			ready: value.ready === true,
			bundleHash:
				typeof value.bundleHash === "string" ? value.bundleHash : undefined,
			lastSuccess:
				typeof value.lastSuccess === "string" ? value.lastSuccess : undefined,
			issues: Array.isArray(value.issues)
				? value.issues.filter((v): v is string => typeof v === "string")
				: [],
		};
	} catch {
		return undefined;
	}
}

/** Startup only needs a compatible live coordinator; availability is checked during acquisition. */
export async function tailnetDaemonHealthy() {
	const health = await readTailnetHealth();

	if (!health?.bundleHash) return false;

	try {
		const { tailnetBundle } = await import("./bundle");

		return health.bundleHash === (await tailnetBundle()).hash;
	} catch {
		return false;
	}
}
