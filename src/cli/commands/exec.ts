import {
	formatCheckSlotWait,
	processCheckSlot,
	withCheckSlot,
} from "../../core/check-slots";
import { BASE_EXITS, defineCommand } from "../command-spec";
import { argumentsError } from "../errors";
import { runForwardingSignals } from "../signal-forward";
import { databaseExists, databaseOverrides } from "./exec-database";
import { loadCommandEnv } from "./load-env";

export const execCommand = defineCommand({
	spec: {
		name: "exec",
		usage: "exec [options] -- <command> [args...]",
		summary: "Run a command with the checkout environment",
		flags: {
			app: {
				kind: "string",
				value: "<name>",
				description: "Use this app's environment and default working directory",
			},
			cwd: {
				kind: "string",
				value: "<path>",
				description: "Working directory relative to the repository root",
			},
			db: {
				kind: "string",
				value: "<name>",
				description:
					"Point the variables that name this checkout's Postgres database at database <name>",
			},
			profile: {
				kind: "string",
				value: "<name>",
				description:
					"Apply a profile's env and secrets overrides (default: the active run's profile, or default)",
			},
			slot: {
				kind: "boolean",
				description:
					"Hold one of the machine-wide check slots (BUNCARGO_CHECK_SLOTS, default 3) while it runs",
			},
		},
		passthrough: "Required: the command; following arguments pass unchanged",
	},
	exits: {
		...BASE_EXITS,
		1: "bad arguments; otherwise the command's own code",
	},
	run: ({ values, passthrough }) => {
		if (passthrough.length === 0) {
			throw argumentsError(["Provide a command after --"], "exec");
		}

		return exec({ ...values, command: [...passthrough] });
	},
});

async function exec(parsed: {
	app: string | undefined;
	cwd: string | undefined;
	db: string | undefined;
	profile: string | undefined;
	slot: boolean;
	command: string[];
}): Promise<number> {
	const env = await loadCommandEnv({ profile: parsed.profile });
	const databaseEnv =
		parsed.db === undefined
			? undefined
			: await databaseOverrides(env, parsed.app, parsed.db, {
					exists: databaseExists,
					inherited: process.env,
				});
	if (databaseEnv) {
		const names = Object.keys(databaseEnv).join(", ");
		console.error(`${names} → database ${parsed.db}`);
	}

	const run = () =>
		runForwardingSignals((signal) =>
			env.exec(parsed.command, {
				app: parsed.app,
				cwd: parsed.cwd,
				verbose: true,
				throwOnError: false,
				signal,
				env: databaseEnv,
			}),
		);
	if (!parsed.slot) return run();

	return withCheckSlot(parsed.command.join(" ").slice(0, 60), run, {
		...processCheckSlot,
		onWait: (wait) => console.error(formatCheckSlotWait(wait)),
	});
}
