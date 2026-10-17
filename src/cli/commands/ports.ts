import { resolve } from "node:path";
import { containerRuntimeForEnv } from "../../container-runtime";
import {
	describeOffsetClaimOverlap,
	offsetClaimHolder,
	offsetClaimRoot,
	offsetClaimsOf,
	overlappingOffsetClaims,
	releaseOffsetClaims,
} from "../../core/offset-claims";
import {
	PORT_OFFSET_STEP,
	pinOffset,
	readOffsetClaimsWithPorts,
} from "../../core/port-allocation";
import { getPortOwner, withBindProbe } from "../../core/process";
import { askConfirm, isInteractive } from "../../core/prompt";
import { findCheckoutRuns, findRunsByRoot } from "../../core/run-registry";
import { loadDevEnv } from "../../loader";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
	readStringFlag,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	root: {
		name: "--root",
		kind: "string",
		valueHint: "=<path>",
		description: "ports release: the checkout whose claims to drop",
	},
	yes: {
		name: "--yes",
		kind: "boolean",
		description: "ports release: skip the confirmation (for scripts)",
	},
} as const;

export const PORTS_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo ports [pin <offset> | release --root <path> [--yes]]",
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
		{
			command: "buncargo ports release --root ../old-worktree",
			description:
				"Drop another checkout's claims on its ports and project name",
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
	if (
		subcommand !== undefined &&
		subcommand !== "pin" &&
		subcommand !== "release"
	)
		problems.push(`Unknown subcommand: ${subcommand}`);
	const root = readStringFlag(args, FLAGS.root, problems);
	const yes = readBooleanFlag(args, FLAGS.yes);
	if (subcommand === "release") {
		if (value !== undefined) problems.push(`Unexpected argument: ${value}`);
		if (root === undefined)
			problems.push("ports release needs the checkout: --root <path>.");
	} else if (root !== undefined || yes)
		problems.push("--root and --yes are only for ports release.");
	if (problems.length > 0) throw argumentsError(problems, "ports");
	if (subcommand === "release" && root !== undefined)
		return releaseClaims(resolve(root), yes);

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

/**
 * `buncargo ports release --root <path>`: drop another checkout's claims.
 *
 * A claim protects an idle checkout's ports and project name, so none is
 * dropped by age. One left by a config its checkout no longer runs (a
 * renamed projectPrefix, not started since) refuses every other checkout
 * under that name until it runs again or is deleted; this is the way out.
 * It refuses while the checkout has a run or standing containers, and
 * touches no container or volume.
 */
async function releaseClaims(root: string, yes: boolean): Promise<number> {
	const claims = offsetClaimsOf(root);
	const keys = Object.keys(claims);
	if (keys.length === 0) {
		log.info(`${root} holds no claim. Nothing to release.`);
		return 0;
	}

	const roots = new Set(
		Object.entries(claims).map(([key, claim]) => offsetClaimRoot(key, claim)),
	);
	for (const claimRoot of roots) {
		const { live, held } = await findCheckoutRuns(claimRoot);
		const stop = `Stop it first: \`buncargo stop --all --root ${claimRoot}\`.`;
		if (live.length > 0)
			throw new CliError(
				`${claimRoot} is running (pid ${live.map((run) => run.pid).join(", ")}), so its claims are in use.`,
				[stop],
			);
		if (held.length > 0)
			throw new CliError(
				`${claimRoot}'s containers from its last run are still standing, under the project name its claim holds.`,
				[stop],
			);
	}

	log.line(`Claims of ${root}:`);
	for (const [key, claim] of Object.entries(claims))
		log.line(
			`  ${offsetClaimHolder(key, claim)}: offset ${claim.offset}, project ${claim.projectName}${claim.ports?.length ? `, ports ${claim.ports.join(", ")}` : ""}`,
		);
	log.warn(
		"Another checkout can then take these ports and run under these project names, using any volume left under them, its database included. No container or volume is touched, and the checkout's next run claims again.",
	);

	if (!yes) {
		if (!isInteractive())
			throw new CliError(
				`Refusing to release ${root}'s claims without a terminal.`,
				["Pass --yes if that is really meant."],
			);
		const accepted = await askConfirm([
			`  Release ${keys.length} claim${keys.length === 1 ? "" : "s"} of ${root}?`,
			"",
			"  y to release  ·  Enter to keep them",
		]);
		if (!accepted) {
			log.info("Kept. Nothing was released.");
			return 0;
		}
	}

	await releaseOffsetClaims(keys);
	log.success(
		`Released ${keys.length} claim${keys.length === 1 ? "" : "s"} of ${root}.`,
	);
	return 0;
}
