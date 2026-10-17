import { containerRuntimeForEnv } from "../../container-runtime";
import {
	describeOffsetClaimOverlap,
	offsetClaimHolder,
	overlappingOffsetClaims,
} from "../../core/offset-claims";
import {
	PORT_OFFSET_STEP,
	pinOffset,
	readOffsetClaimsWithPorts,
} from "../../core/port-allocation";
import { getPortOwner, withBindProbe } from "../../core/process";
import { findRunsByRoot } from "../../core/run-registry";
import { loadDevEnv } from "../../loader";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
} as const;

export const PORTS_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo ports [pin <offset>]",
	flags: Object.values(FLAGS),
	examples: [
		{
			command: "buncargo ports",
			description: "This checkout's ports, and every checkout's offset",
		},
		{
			command: "buncargo ports pin 2500",
			description: "Keep this checkout on offset 2500 from now on",
		},
	],
};

/** A whole number of steps, so pinned blocks line up with allocated ones. */
export function parsePinnedOffset(value: string | undefined): number {
	const offset = Number(value);
	if (
		value === undefined ||
		!Number.isInteger(offset) ||
		offset < 0 ||
		offset % PORT_OFFSET_STEP !== 0
	)
		throw new CliError(
			`ports pin takes an offset in steps of ${PORT_OFFSET_STEP}, e.g. 2500: got "${value ?? ""}".`,
		);
	return offset;
}

/**
 * `buncargo ports`: where this checkout's ports are, and every checkout's
 * offset on the machine. `ports pin <offset>` moves this checkout to a block
 * and keeps it there: it checks every port of the block first (by binding
 * it, so a holder `lsof` cannot see counts), writes the lockfile and claims
 * the offset, so no other checkout is given it.
 */
export async function handlePorts(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(PORTS_COMMAND_SPEC));
		return 0;
	}
	const [subcommand, value, ...extra] = readPositionals(
		PORTS_COMMAND_SPEC,
		args,
	);
	const problems = [
		...findUnknownFlags(PORTS_COMMAND_SPEC, args).map(
			(f) => `Unknown flag: ${f}`,
		),
		...extra.map((arg) => `Unexpected argument: ${arg}`),
	];
	if (subcommand !== undefined && subcommand !== "pin")
		problems.push(`Unknown subcommand: ${subcommand}`);
	if (problems.length > 0) throw argumentsError(problems, "ports");

	const env = await loadDevEnv({ readOnly: true });

	if (subcommand === undefined) {
		const claims = readOffsetClaimsWithPorts();
		log.line(
			`${env.projectName}: offset ${env.portOffset} (${env.portOffsetProvenance})`,
		);
		for (const [name, port] of Object.entries(
			env.ports as Record<string, number>,
		))
			log.line(`  ${name}: ${port}`);
		log.line();
		log.line("Offsets claimed on this machine:");
		for (const [key, claim] of Object.entries(claims).sort(
			([, a], [, b]) => a.offset - b.offset,
		))
			log.line(
				`  ${String(claim.offset).padStart(5)}  ${offsetClaimHolder(key, claim)}`,
			);
		const overlaps = overlappingOffsetClaims(claims);
		if (overlaps.length > 0) {
			log.line();
			log.line(
				"Overlapping claims (`buncargo ports pin <offset>` in one of them moves it):",
			);
			for (const overlap of overlaps)
				log.line(`  ${describeOffsetClaimOverlap(overlap)}`);
		}
		return 0;
	}

	const offset = parsePinnedOffset(value);
	const runtime = containerRuntimeForEnv(env);
	const result = pinOffset({
		root: env.root,
		projectName: env.projectName,
		services: env.services as Parameters<typeof pinOffset>[0]["services"],
		apps: env.apps as Parameters<typeof pinOffset>[0]["apps"],
		offset,
		worktreeIsolation: env.worktreeIsolation,
		runtime: runtime.name,
		getOwner: withBindProbe((port) => getPortOwner(port, { runtime })),
	});
	if ("refused" in result)
		throw new CliError(
			result.refused,
			result.claimed
				? ["Pick another one: `buncargo ports` lists the claimed offsets."]
				: [],
		);
	log.success(`Pinned ${env.projectName} to offset ${offset}.`);
	// The services' containers are recreated on the next start: their
	// published ports are part of what decides whether one is reused.
	const running = (await findRunsByRoot(env.root).catch(() => [])).length > 0;
	log.hint(
		running
			? "The run in this checkout still uses the old ports: restart it (`buncargo stop --all`, then `buncargo dev`)."
			: "The next `buncargo dev` starts on the new ports.",
	);
	return 0;
}
