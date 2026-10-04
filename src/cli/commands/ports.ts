import { containerRuntimeForEnv } from "../../container-runtime";
import {
	claimOffset,
	duplicateOffsetClaims,
	offsetClaimedBy,
	readOffsetClaims,
} from "../../core/offset-claims";
import {
	buildPortMap,
	describePortConflict,
	PORT_OFFSET_STEP,
	writePortsLockfile,
} from "../../core/port-allocation";
import {
	classifyPortOccupant,
	getPortOwner,
	withBindProbe,
} from "../../core/process";
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
	const claims = readOffsetClaims();

	if (subcommand === undefined) {
		log.line(
			`${env.projectName}: offset ${env.portOffset} (${env.portOffsetProvenance})`,
		);
		for (const [name, port] of Object.entries(
			env.ports as Record<string, number>,
		))
			log.line(`  ${name}: ${port}`);
		log.line();
		log.line("Offsets claimed on this machine:");
		const duplicates = duplicateOffsetClaims(claims);
		for (const [root, claim] of Object.entries(claims).sort(
			([, a], [, b]) => a.offset - b.offset,
		))
			log.line(
				`  ${String(claim.offset).padStart(5)}  ${root}${duplicates.has(claim.offset) ? "  (claimed twice)" : ""}`,
			);
		return 0;
	}

	const offset = parsePinnedOffset(value);
	const holder = offsetClaimedBy(claims, offset, env.root);
	if (holder)
		throw new CliError(`Offset ${offset} is claimed by ${holder}.`, [
			"Pick another one: `buncargo ports` lists the claimed offsets.",
		]);

	const ports = buildPortMap(
		env.services as Parameters<typeof buildPortMap>[0],
		env.apps as Parameters<typeof buildPortMap>[1],
		offset,
	);
	const runtime = containerRuntimeForEnv(env);
	const ownerOf = withBindProbe((port) => getPortOwner(port, { runtime }));
	for (const port of Object.values(ports)) {
		if (port > 65535)
			throw new CliError(`Offset ${offset} puts port ${port} above 65535.`);
		const owner = ownerOf(port);
		const action = classifyPortOccupant(owner, {
			root: env.root,
			projectName: env.projectName,
			runtime: runtime.name,
		});
		if (action === "fail" && owner)
			throw new CliError(
				`Offset ${offset} is not free: ${describePortConflict(port, owner)}.`,
			);
	}

	writePortsLockfile(env.root, {
		version: 1,
		projectName: env.projectName,
		root: env.root,
		offset,
		ports,
		provenance: "lockfile",
	});
	claimOffset(env.root, offset, env.projectName);
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
