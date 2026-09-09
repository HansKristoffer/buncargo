import { matchesProcessIdentity } from "../process-identity";
import { readJsonDocument, writeJsonDocument } from "../registry-file";
import { stateFilePath } from "../state-paths";
import { record } from "./protocol";

export const COORDINATOR_MAX_AGE_MS = 10000;

export interface CoordinatorState {
	pid: number;
	identity: string;
	bundle: string;
	updatedAt: number;
	ready: boolean;
	connection?: { port: number; token: string };
	cli: { program: string; script?: string };
}

export const coordinatorStatePath = () =>
	stateFilePath("connect-coordinator.json");

export const intentsPath = () => stateFilePath("connect-intents");

export async function readCoordinatorState(
	liveOnly = true,
): Promise<CoordinatorState | undefined> {
	const state = await readJsonDocument(coordinatorStatePath(), (value) => {
		const state = record(value);
		if (
			typeof state.pid !== "number" ||
			!Number.isInteger(state.pid) ||
			state.pid <= 0 ||
			typeof state.identity !== "string" ||
			typeof state.bundle !== "string" ||
			typeof state.updatedAt !== "number" ||
			!Number.isFinite(state.updatedAt) ||
			typeof state.ready !== "boolean"
		) {
			return;
		}
		const cli = record(state.cli);
		if (
			typeof cli.program !== "string" ||
			(cli.script !== undefined && typeof cli.script !== "string")
		) {
			return;
		}
		const connection = record(state.connection);
		if (
			!Number.isInteger(connection.port) ||
			typeof connection.token !== "string"
		) {
			return;
		}

		return state as unknown as CoordinatorState;
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
