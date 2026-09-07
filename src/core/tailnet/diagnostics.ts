import { installedTailnetAgent, tailnetBundle } from "./bundle";
import {
	createTailscaleClient,
	mappingState,
	serveState,
	type TailscaleCommand,
	tailnetStatus,
} from "./client";
import { readTailnetHealth } from "./health";
import { leaseTarget } from "./runtime";
import { readTailnetState } from "./state";

const defaults = {
	state: readTailnetState,
	health: readTailnetHealth,
	installed: installedTailnetAgent,
	bundle: tailnetBundle,
};

/** Read-only diagnostics remain useful even if the CLI, state, or coordinator is unavailable. */
export async function tailnetDiagnostics(
	command: TailscaleCommand = createTailscaleClient(),
	overrides: Partial<typeof defaults> = {},
) {
	const deps = { ...defaults, ...overrides };
	const issues: string[] = [];
	let state: ReturnType<typeof readTailnetState> | undefined;

	try {
		state = deps.state();
	} catch (error) {
		issues.push(String(error));
	}

	// Collect independent evidence: a disconnected CLI should not hide installed state or health.
	const [health, installed, expected, status, actual] =
		await Promise.allSettled([
			deps.health(),
			deps.installed(),
			deps.bundle(),
			tailnetStatus(command),
			serveState(command),
		]);

	const coordinator = health.status === "fulfilled" ? health.value : undefined;

	const manifest =
		installed.status === "fulfilled" ? installed.value : undefined;

	const expectedHash =
		expected.status === "fulfilled" ? expected.value.hash : undefined;

	if (status.status === "rejected") issues.push(String(status.reason));

	if (actual.status === "rejected") issues.push(String(actual.reason));

	// A responding coordinator can still be running an older copy of the bundle.
	const stale =
		expectedHash !== undefined && coordinator?.bundleHash !== undefined
			? expectedHash !== coordinator.bundleHash
			: undefined;

	if (stale || (coordinator && !coordinator.bundleHash))
		issues.push("Coordinator is outdated; rerun buncargo tailnet install");

	if (!coordinator)
		issues.push("Coordinator not running; run buncargo tailnet install");

	if (state?.removing)
		issues.push(
			"Uninstall pending; coordinator retries cleanup. Rerun tailnet uninstall to remove the service.",
		);

	return {
		enabled: state?.enabled ?? null,
		removing: state?.removing ?? false,
		hostname: status.status === "fulfilled" ? status.value.self.hostname : null,
		coordinator: coordinator ?? null,
		installed: manifest ?? null,
		stale: stale ?? null,
		issues: [...issues, ...(coordinator?.issues ?? [])],
		allocations:
			state?.allocations.map((a) => {
				// A lease records intent. Only the current Serve snapshot can confirm its mapping.
				const mapping =
					a.lease && actual.status === "fulfilled"
						? mappingState(
								actual.value,
								a.lease.hostname,
								a.port,
								leaseTarget(a.lease),
							)
						: "unknown";

				return {
					port: a.port,
					app: a.lease?.app,
					pendingRemoval: !!(state?.removing || a.lease?.pendingRemoval),
					active:
						!!a.lease &&
						!a.lease.pendingRemoval &&
						!state?.removing &&
						status.status === "fulfilled" &&
						mapping === "owned",
					mapping,
				};
			}) ?? [],
	};
}
