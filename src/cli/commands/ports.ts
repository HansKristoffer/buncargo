import { resolve } from "node:path";
import {
	containerRuntimeForEnv,
	readClaimStates,
} from "../../container-runtime";
import { tailscaleBlockPorts } from "../../core/hosts/tailscale-serve";
import {
	describeOffsetClaimOverlap,
	markOffsetClaimsReclaimed,
	offsetClaimHolder,
	offsetClaimRoot,
	offsetClaimsOf,
	overlappingOffsetClaims,
	readOffsetClaims,
	releaseOffsetClaimsIfUnchanged,
} from "../../core/offset-claims";
import {
	PORT_OFFSET_STEP,
	pinOffset,
	readOffsetClaimsWithPorts,
} from "../../core/port-allocation";
import {
	CLAIM_STATE_LABELS,
	formatClaimAge,
	idleClaims,
	unallocatedPortsMessage,
} from "../../core/port-exhaustion";
import { getPortOwner, withBindProbe } from "../../core/process";
import { askConfirm, isInteractive } from "../../core/prompt";
import { findCheckoutRuns, findRunsByRoot } from "../../core/run-registry";
import { hostsMode } from "../../core/runtime-flags";
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
	idle: {
		name: "--idle",
		kind: "string",
		valueHint: "=<duration>",
		description:
			"ports release: free the blocks of checkouts idle longer than this (7d, 12h; a bare number is days) with no run and no containers; each keeps its project name. Deleted checkouts' claims are left to the sweep",
	},
	yes: {
		name: "--yes",
		kind: "boolean",
		description: "ports release: skip the confirmation (for scripts)",
	},
} as const;

export const PORTS_COMMAND_SPEC: CommandSpec = {
	usage:
		"buncargo ports [pin <offset> | release (--root <path> | --idle=<duration>) [--yes]]",
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
		{
			command: "buncargo ports release --idle=7d",
			description:
				"Free the blocks of every checkout not started for a week, with no run and no containers",
		},
	],
};

const DURATION_UNIT_MS: Record<string, number> = {
	d: 86_400_000,
	h: 3_600_000,
	m: 60_000,
};

/**
 * `7d`, `12h`, `30m`, or a bare number of days: in milliseconds, and as the
 * messages spell it. Undefined for anything else, zero included.
 */
export function parseIdleDuration(
	value: string,
): { ms: number; label: string } | undefined {
	const match = /^(\d+(?:\.\d+)?)(d|h|m)?$/.exec(value.trim());
	if (!match) return undefined;
	const unit = match[2] ?? "d";
	const ms = Number(match[1]) * DURATION_UNIT_MS[unit];
	return ms > 0 ? { ms, label: `${match[1]}${unit}` } : undefined;
}

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
	const idle = readStringFlag(args, FLAGS.idle, problems);
	const idleFor = idle === undefined ? undefined : parseIdleDuration(idle);
	const yes = readBooleanFlag(args, FLAGS.yes);
	if (subcommand === "release") {
		if (value !== undefined) problems.push(`Unexpected argument: ${value}`);
		if ((root === undefined) === (idle === undefined))
			problems.push(
				"ports release needs either the checkout (--root <path>) or an idle time (--idle=7d).",
			);
		if (idle !== undefined && idleFor === undefined)
			problems.push(
				`--idle takes a duration such as 7d, 12h or 30m (a bare number is days): got "${idle}".`,
			);
	} else if (root !== undefined || idle !== undefined || yes)
		problems.push("--root, --idle and --yes are only for ports release.");
	if (problems.length > 0) throw argumentsError(problems, "ports");
	if (subcommand === "release" && root !== undefined)
		return releaseClaims(resolve(root), yes);
	if (subcommand === "release" && idleFor !== undefined)
		return releaseIdleClaims(idleFor, yes);

	const env = await loadDevEnv({ readOnly: true });

	if (subcommand === undefined) {
		const claims = readOffsetClaimsWithPorts();
		const unallocated = env.portOffsetProvenance === "unallocated";
		log.line(
			`${env.projectName}: offset ${env.portOffset} (${env.portOffsetProvenance})`,
		);
		for (const [name, port] of Object.entries(
			env.ports as Record<string, number>,
		))
			log.line(`  ${name}: ${port}`);
		if (unallocated) log.warn(unallocatedPortsMessage(env.root));
		// Which holder could give a block up is worth a runtime listing only
		// when this checkout needs one.
		const states = unallocated
			? await readClaimStates(claims).catch(() => undefined)
			: undefined;
		const now = Date.now();
		log.line();
		log.line("Offsets claimed on this machine (last used):");
		for (const [key, claim] of Object.entries(claims).sort(
			([, a], [, b]) => a.offset - b.offset,
		)) {
			const state = states ? `, ${CLAIM_STATE_LABELS[states[key]]}` : "";
			log.line(
				`  ${String(claim.offset).padStart(5)}  ${offsetClaimHolder(key, claim)} (${formatClaimAge(key, claim, now)} ago${state})`,
			);
		}
		if (unallocated)
			log.hint(
				"`buncargo ports release --idle=7d` frees the blocks of checkouts not started for a week that have no run and no containers.",
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
		companionPorts: tailscaleBlockPorts({
			mode: hostsMode(),
			hosts: env.hosts !== null,
			appNames: Object.keys(env.apps),
		}),
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
 * dropped by age unless asked (`--idle`) or the range is full. One left by a config its checkout no longer runs (a
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
	for (const [key, claim] of Object.entries(claims)) {
		const ports = claim.ports?.length
			? `, ports ${claim.ports.join(", ")}`
			: "";
		log.line(
			`  ${offsetClaimHolder(key, claim)}: offset ${claim.offset}, project ${claim.projectName}${ports}`,
		);
	}
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

	// Only what was listed and checked: a run that started since the check
	// rewrote its claim, and keeps it.
	const released = await releaseOffsetClaimsIfUnchanged(claims);
	log.success(
		`Released ${released.length} claim${released.length === 1 ? "" : "s"} of ${root}.`,
	);
	const kept = keys.length - released.length;
	if (kept > 0)
		log.warn(
			`Kept ${kept}: a run used them after they were listed. Run \`buncargo ports release --root ${root}\` again once it has stopped.`,
		);
	return 0;
}

/**
 * `buncargo ports release --idle=<duration>`: free the blocks of every
 * checkout not started for that long that has no run and no containers, the
 * ones a full range would reclaim first, the same way: each claim is marked
 * reclaimed and stays, so its checkout keeps its project name and its
 * volumes stay known to `prune`.
 *
 * A deleted checkout's claim is not among them: allocation already ignores
 * it, and it is the sweep's record of its volumes. A claim a run used
 * between the listing and the confirmation keeps its block.
 */
async function releaseIdleClaims(
	idleFor: { ms: number; label: string },
	yes: boolean,
): Promise<number> {
	const { label } = idleFor;
	const claims = readOffsetClaims();
	const states = await readClaimStates(claims);
	const now = Date.now();
	const stale = idleClaims(claims, states, idleFor.ms, now);
	const keys = Object.keys(stale);
	if (keys.length === 0) {
		log.info(
			`No claim is idle for longer than ${label} with no run and no containers. Nothing to release.`,
		);
		return 0;
	}

	log.line(`Claims idle for longer than ${label}:`);
	for (const [key, claim] of Object.entries(stale))
		log.line(
			`  ${String(claim.offset).padStart(5)}  ${offsetClaimHolder(key, claim)}: project ${claim.projectName}, last used ${formatClaimAge(key, claim, now)} ago`,
		);
	log.warn(
		"Other checkouts can then take these ports. Each claim stays without its block, so its checkout keeps its project name and its database; its next run claims a block again, on new ports if this one was taken. No container or volume is touched.",
	);

	const count = `${keys.length} claim${keys.length === 1 ? "" : "s"}`;
	if (!yes) {
		if (!isInteractive())
			throw new CliError(`Refusing to release ${count} without a terminal.`, [
				"Pass --yes if that is really meant.",
			]);
		const accepted = await askConfirm([
			`  Release ${count} idle for longer than ${label}?`,
			"",
			"  y to release  ·  Enter to keep them",
		]);
		if (!accepted) {
			log.info("Kept. Nothing was released.");
			return 0;
		}
	}

	const released = await markOffsetClaimsReclaimed(
		stale,
		new Date(now).toISOString(),
	);
	log.success(
		`Freed the blocks of ${released.length} claim${released.length === 1 ? "" : "s"}.`,
	);
	const kept = keys.length - released.length;
	if (kept > 0)
		log.hint(
			`${kept} changed since they were listed (a run started) and ${kept === 1 ? "was" : "were"} kept.`,
		);
	return 0;
}
