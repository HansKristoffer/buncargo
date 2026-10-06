import { constants } from "node:os";
import { formatCheckSlotHolder, withCheckSlot } from "../../core/check-slots";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
} from "../command-spec";

/**
 * `buncargo slot -- <command>`: run a command inside one of the machine-wide
 * check slots, exactly as the shell would run it.
 *
 * `exec --slot` also gives the command the checkout environment: the dev
 * stack's URLs and the config's secrets. A unit test suite that mocks Redis
 * unless `REDIS_URL` is set then behaves differently, so heavy commands that
 * need no checkout environment take their slot here.
 */

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
} as const;

export const SLOT_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo slot -- <command> [args...]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "--",
			description:
				"Required separator; following arguments are passed unchanged",
		},
	],
	examples: [
		{
			command: "bunx buncargo slot -- bun test",
			description:
				"Run a test suite once a slot is free, with the shell's own environment",
		},
	],
};

export function parseSlotArgs(args: string[]) {
	// Only the prefix belongs to buncargo; child argv is never parsed.
	const separator = args.indexOf("--");
	const optionArgs = separator < 0 ? args : args.slice(0, separator);
	const command = separator < 0 ? [] : args.slice(separator + 1);
	const help = readBooleanFlag(optionArgs, FLAGS.help);

	const errors = [
		...findUnknownFlags(SLOT_COMMAND_SPEC, optionArgs).map(
			(flag) => `Unknown flag: ${flag}`,
		),
		...readPositionals(SLOT_COMMAND_SPEC, optionArgs).map(
			(token) => `Unexpected argument before --: ${token}`,
		),
	];
	if (!help && command.length === 0) errors.push("Provide a command after --");

	return { help, command, errors };
}

export async function handleSlot(args: string[]): Promise<number> {
	const parsed = parseSlotArgs(args);
	if (parsed.help) {
		console.log(formatCommandHelp(SLOT_COMMAND_SPEC));
		return 0;
	}
	if (parsed.errors.length > 0) throw new Error(parsed.errors.join("\n"));

	return withCheckSlot(
		parsed.command.join(" ").slice(0, 60),
		async () => {
			// process.env is inherited as is, plus BUNCARGO_CHECK_SLOT so a
			// buncargo typecheck inside does not wait for a second slot.
			const child = Bun.spawn(parsed.command, {
				stdio: ["inherit", "inherit", "inherit"],
				env: process.env,
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
			onWait: (holders) =>
				console.error(
					`Waiting for a check slot: ${holders.map(formatCheckSlotHolder).join(", ")}`,
				),
		},
	);
}
