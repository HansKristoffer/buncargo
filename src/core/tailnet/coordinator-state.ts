import { matchesProcessIdentity } from "../process-identity";
import { readJsonDocument, writeJsonDocument } from "../registry-file";
import { stateFilePath } from "../state-paths";
import { record } from "./client";
export const COORDINATOR_STARTING = "Connecting to Tailscale…";
export const COORDINATOR_MAX_AGE_MS = 10000;

export interface CoordinatorState {
	pid: number;
	identity: string;
	bundle: string;
	updatedAt: number;
	ready: boolean;
	message?: string;
	connection?: { binary: string; socket?: string };
	cli: { program: string; script?: string };
}
export const coordinatorStatePath = () =>
	stateFilePath("tailnet-coordinator.json");
export async function readCoordinatorState(
	liveOnly = true,
): Promise<CoordinatorState | undefined> {
	const state = await readJsonDocument(coordinatorStatePath(), (value) => {
		const s = record(value);
		if (
			typeof s.pid !== "number" ||
			!Number.isInteger(s.pid) ||
			s.pid <= 0 ||
			typeof s.identity !== "string" ||
			typeof s.bundle !== "string" ||
			typeof s.updatedAt !== "number" ||
			!Number.isFinite(s.updatedAt) ||
			typeof s.ready !== "boolean" ||
			(s.message !== undefined && typeof s.message !== "string")
		)
			return;
		const cli = record(s.cli);
		if (
			typeof cli.program !== "string" ||
			(cli.script !== undefined && typeof cli.script !== "string")
		)
			return;
		if (s.connection !== undefined) {
			const connection = record(s.connection);
			if (
				typeof connection.binary !== "string" ||
				(connection.socket !== undefined &&
					typeof connection.socket !== "string")
			)
				return;
		}
		return s as unknown as CoordinatorState;
	});
	return state &&
		(!liveOnly || matchesProcessIdentity(state.pid, state.identity))
		? state
		: undefined;
}
export const writeCoordinatorState = (state: CoordinatorState) =>
	writeJsonDocument(coordinatorStatePath(), state);

/** Readiness requires a fresh heartbeat from the same live process, not just a saved ready flag. */
export function isCoordinatorReady(
	state: CoordinatorState | undefined,
	now = Date.now(),
): boolean {
	return (
		!!state &&
		state.ready &&
		Math.abs(now - state.updatedAt) < COORDINATOR_MAX_AGE_MS &&
		matchesProcessIdentity(state.pid, state.identity)
	);
}
