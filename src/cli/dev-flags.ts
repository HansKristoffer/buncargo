import { CONTAINER_RUNTIME_SELECTIONS } from "../container-runtime";
import { isTimingEnabled } from "../core/runtime-flags";
import {
	type CommandSpec,
	commaList,
	enumValidator,
	type Parsed,
	type ParseResult,
	parseArgs,
	positiveIntegerValidator,
} from "./command-spec";
import { argumentsError } from "./errors";

export const DEV_SPEC = {
	name: "dev",
	summary: "Start the development environment",
	flags: {
		down: { kind: "boolean", description: "Stop all containers" },
		all: {
			kind: "boolean",
			description:
				"With --down, stop every buncargo environment you started on this machine",
		},
		reset: {
			kind: "boolean",
			description: "Stop containers and remove volumes (fresh start)",
		},
		yes: {
			kind: "boolean",
			description:
				"Confirm --reset or --down --all without a prompt (required without a terminal)",
		},
		migrate: { kind: "boolean", description: "Run migrations and exit" },
		seed: {
			kind: "boolean",
			description: "Run migrations and seeders, then exit",
		},
		"up-only": {
			kind: "boolean",
			description:
				"Start containers only, then exit (no migrations, seed, or dev servers)",
		},
		expose: {
			kind: "optional",
			value: "<targets>",
			description: "Expose configured targets via public quick tunnels",
		},
		apps: {
			kind: "string",
			value: "<apps>",
			description: "Run selected apps plus their requiredApps (as <app>...)",
		},
		profile: {
			kind: "string",
			value: "<name>",
			description: "Run a profile's apps (default: the profile named default)",
		},
		attach: {
			kind: "string",
			value: "<app>",
			description: "Give one app the TTY (overrides interactive: true)",
		},
		"no-watch": {
			kind: "boolean",
			description: "Do not restart apps when their watched files change",
		},
		detach: {
			kind: "boolean",
			description:
				"Run in the background; return once the apps are up (logs: buncargo logs)",
		},
		keep: {
			kind: "boolean",
			description:
				"With --detach: never stop for idling (default: stops after 2h with no request or buncargo command)",
		},
		json: {
			kind: "boolean",
			description:
				"With --detach: print the outcome as one JSON document (DetachedResultJson)",
		},
		tui: {
			kind: "boolean",
			description:
				"Terminal UI, the default in a terminal; warns when there is none",
		},
		"no-tui": {
			kind: "boolean",
			description:
				"Prefixed lines instead of the terminal UI, even in a terminal",
		},
		"keep-containers": {
			kind: "boolean",
			description:
				"Keep the containers after the run exits, as long as the checkout exists",
		},
		takeover: {
			kind: "boolean",
			description: "Stop apps already running elsewhere and run them here",
		},
		"replace-stale": {
			kind: "boolean",
			description:
				"First remove this checkout's stacks under an old project name (keeps volumes)",
		},
		"watchdog-timeout": {
			kind: "string",
			value: "N",
			description: "Idle backstop in minutes (default: 3)",
			validate: positiveIntegerValidator("--watchdog-timeout"),
		},
		"no-docker-autostart": {
			kind: "boolean",
			description: "Do not try to start Docker if it is down",
		},
		"no-hosts": {
			kind: "boolean",
			description: "Use localhost:port instead of named .localhost URLs",
		},
		runtime: {
			kind: "string",
			value: "<docker|apple|auto>",
			description: "Container runtime backend (default: docker)",
			validate: enumValidator("--runtime", CONTAINER_RUNTIME_SELECTIONS),
		},
		"timing-json": {
			kind: "boolean",
			description: "Report startup through app readiness as JSON",
		},
		timing: {
			kind: "boolean",
			description: "Print how long each startup phase took",
		},
	},
	args: [
		{
			name: "<app>",
			description: "Run only these apps, plus their requiredApps",
			variadic: true,
		},
	],
	passthrough: "Extra args appended to the attached app command",
	examples: [
		{
			command: "bun dev",
			description: "Start selected apps and their services",
		},
		{
			command: "bun dev api platform",
			description: "Run only these apps",
		},
		{
			command: "bun dev --seed",
			description: "Run migrations and seed the database",
		},
		{ command: "bun dev --down", description: "Stop all containers" },
		{
			command: "bun dev --reset",
			description: "Stop containers and remove all data",
		},
		{
			command: "bun dev --profile=full",
			description: "Run the apps of profiles.full",
		},
		{
			command: "bun dev --detach --json",
			description: "Start in the background; print the outcome as JSON",
		},
		{
			command: "bun dev --expose",
			description: "Expose all targets with expose: true",
		},
		{
			command: "bun dev --expose=api,web",
			description: "Expose specific targets",
		},
		{
			command: "bun dev expoApp -- --clear",
			description: "Pass args to the attached app",
		},
		{
			command: "bun dev --runtime=apple",
			description: "Run services on Apple container instead of Docker",
		},
		{
			command: "bun dev --no-tui",
			description: "Prefixed lines instead of the terminal UI",
		},
		{
			command: "bun dev --takeover",
			description: "Move apps running in another terminal into this one",
		},
	],
} as const satisfies CommandSpec;

export type DevArgs = Parsed<typeof DEV_SPEC>;
type DevValues = DevArgs["values"];

/**
 * The flags only the `dev --detach` in front reads: its background run gets
 * the rest of the invocation, and `--keep` through `BUNCARGO_DETACHED`.
 */
export const DETACH_ONLY_FLAGS: readonly string[] = [
	"--detach",
	"--keep",
	"--json",
];

/** `--migrate`, `--seed` or `--up-only`, which exit before dev servers start. */
export function oneShotMode(values: DevValues): string | undefined {
	if (values.migrate) return "--migrate";
	if (values.seed) return "--seed";
	if (values["up-only"]) return "--up-only";
	return undefined;
}

export function isOneShot(values: DevValues): boolean {
	return oneShotMode(values) !== undefined;
}

/**
 * Whether this run opens tunnels: never in a one-shot mode, where `--expose`
 * would print a URL that closes as the command exits.
 */
export function exposeRequested(values: DevValues): boolean {
	return values.expose !== undefined && !isOneShot(values);
}

/** `--expose=<targets>`, or undefined for every `expose: true` target. */
export function exposeTargets(values: DevValues): string | undefined {
	return typeof values.expose === "string" ? values.expose : undefined;
}

export function tuiMode(values: DevValues): "auto" | "on" | "off" {
	if (values["no-tui"]) return "off";
	return values.tui ? "on" : "auto";
}

/** `--timing`, `--timing-json` or `BUNCARGO_TIMING`: print the startup breakdown. */
export function timingRequested(values: DevValues): boolean {
	// Either way in: the flag for a one-off look, the environment variable
	// for a shell or an agent that wants it on every run.
	return values.timing || values["timing-json"] || isTimingEnabled();
}

/**
 * Flags a one-shot mode ignores, with why: `--expose` would open a tunnel
 * that closes as the command exits, printing a URL that is already dead;
 * `--takeover` has no app to move here.
 */
export function ignoredFlagWarnings(values: DevValues): string[] {
	const mode = oneShotMode(values);
	if (mode === undefined) return [];
	const ignored: string[] = [];
	if (values.expose !== undefined)
		ignored.push(
			`--expose is ignored with ${mode}: its tunnels would close as the command exits. Share a running app with \`buncargo dev --detach --expose\`.`,
		);
	if (values.takeover)
		ignored.push(
			`--takeover is ignored with ${mode}: it starts no app to take over.`,
		);
	return ignored;
}

/** The apps named as arguments or with `--apps`, or undefined for none. */
export function requestedApps(args: DevArgs): string[] | undefined {
	if (args.positionals.length > 0) return [...args.positionals];
	return args.values.apps === undefined
		? undefined
		: commaList(args.values.apps);
}

/** Throw for combinations of flags that are each valid alone. */
export function assertDevArgs(args: DevArgs): void {
	const values = args.values;
	const errors: string[] = [];
	const modes = [
		values.migrate,
		values.seed,
		values["up-only"],
		values.down,
		values.reset,
	];
	if (modes.filter(Boolean).length > 1)
		errors.push(
			"Choose only one of --migrate, --seed, --up-only, --down, or --reset.",
		);
	if (values.all && !values.down) errors.push("--all requires --down.");
	if (values["replace-stale"] && (values.down || values.reset))
		errors.push(
			"--replace-stale clears the way for a start; it cannot be combined with --down or --reset.",
		);
	if (values.tui && values["no-tui"])
		errors.push("Choose either --tui or --no-tui, not both.");
	if (values.keep && !values.detach)
		errors.push(
			"--keep only applies to --detach: a run in a terminal never stops for idling.",
		);
	if (values.json && !values.detach)
		errors.push(
			"--json only applies to --detach; a run in a terminal prints its own output.",
		);
	const named = args.positionals.length > 0;
	if (named && values.apps !== undefined)
		errors.push("Name the apps as arguments or with --apps, not both.");
	if ((named || values.apps !== undefined) && values.profile !== undefined)
		errors.push("Choose either apps or --profile, not both.");
	if (values.apps !== undefined && commaList(values.apps).length === 0)
		errors.push("--apps requires at least one app name.");
	if (values.detach && (modes.some(Boolean) || values.tui || values.attach))
		errors.push(
			"--detach runs the dev servers in the background; it cannot be combined with --tui, --attach or a one-shot mode.",
		);
	if (errors.length > 0) throw argumentsError(errors, "dev");
}

/**
 * `dev`'s argv. Both entry points parse it: `devCommand` before it loads a
 * config, so a typo is not answered with a config error, and `runCli`, which
 * programmatic callers reach directly with their own argv.
 */
export function parseDevArgs(
	argv: readonly string[],
): ParseResult<typeof DEV_SPEC> {
	const parsed = parseArgs(DEV_SPEC, argv);
	if (!parsed.help) assertDevArgs(parsed);
	return parsed;
}

/**
 * What a mode that destroys someone else's state needs before it runs.
 *
 * `--reset` deletes the checkout's volumes and `--down --all` stops every
 * other checkout's run. An agent running `dev --reset` to "fix" a migration
 * wiped a developer's data, so without a terminal neither runs unless `--yes`
 * says it was meant. CI is exempt: its containers are disposable and its
 * pipelines already pass these flags.
 */
export function destructiveModeGate(
	values: Pick<DevValues, "reset" | "down" | "all" | "yes">,
	context: { interactive: boolean; ci: boolean },
): "run" | "confirm" | "refuse" {
	const destructive = values.reset || (values.down && values.all);
	if (!destructive || values.yes || context.ci) return "run";
	return context.interactive ? "confirm" : "refuse";
}
