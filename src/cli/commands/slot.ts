import { constants } from "node:os";
import { formatCheckSlotWait, withCheckSlot } from "../../core/check-slots";
import { childProcessEnv } from "../../core/child-env";
import { BASE_EXITS, defineCommand } from "../command-spec";
import { argumentsError } from "../errors";

/**
 * `buncargo slot -- <command>`: run a command inside one of the machine-wide
 * check slots, exactly as the shell would run it.
 *
 * `exec --slot` also gives the command the checkout environment: the dev
 * stack's URLs and the config's secrets. A unit test suite that mocks Redis
 * unless `REDIS_URL` is set then behaves differently, so heavy commands that
 * need no checkout environment take their slot here.
 */

async function runInSlot(command: string[]): Promise<number> {
	return withCheckSlot(
		command.join(" ").slice(0, 60),
		async () => {
			// The shell's environment, plus BUNCARGO_CHECK_SLOT so a buncargo
			// typecheck inside does not wait for a second slot, minus the
			// connect tokens no project process gets.
			const child = Bun.spawn(command, {
				stdio: ["inherit", "inherit", "inherit"],
				env: childProcessEnv(),
			});
			const forward = (signal: NodeJS.Signals) => child.kill(signal);
			const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
			for (const signal of signals) process.on(signal, forward);

			try {
				const exitCode = await child.exited;
				// Shell semantics for a signalled child: 128 + signal number.
				return child.signalCode
					? 128 + (constants.signals[child.signalCode] ?? 0)
					: exitCode;
			} finally {
				for (const signal of signals) process.off(signal, forward);
			}
		},
		{
			onWait: (wait) => console.error(formatCheckSlotWait(wait)),
		},
	);
}

export const slotCommand = defineCommand({
	spec: {
		name: "slot",
		usage: "slot -- <command> [args...]",
		summary:
			"Run a heavy command in a machine-wide check slot, environment untouched",
		flags: {},
		passthrough: "Required: the command; following arguments pass unchanged",
		examples: [
			{
				command: "bunx buncargo slot -- bun test",
				description:
					"Run a test suite once a slot is free, with the shell's own environment",
			},
		],
	},
	exits: {
		...BASE_EXITS,
		1: "bad arguments; otherwise the command's own code (128 + N for a signal)",
	},
	run: ({ passthrough }) => {
		if (passthrough.length === 0)
			throw argumentsError(["Provide a command after --"], "slot");
		return runInSlot([...passthrough]);
	},
});
