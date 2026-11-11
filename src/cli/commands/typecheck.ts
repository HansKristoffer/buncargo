import { getErrorMessage } from "hanzio";
import {
	BASE_EXITS,
	commaList,
	defineCommand,
	positiveIntegerValidator,
} from "../command-spec";
import { argumentsError } from "../errors";
import * as log from "../log";

export const typecheckCommand = defineCommand({
	spec: {
		name: "typecheck",
		summary: "Run TypeScript typecheck across workspaces",
		flags: {
			concurrency: {
				kind: "string",
				value: "N",
				description:
					"Max typecheck processes (default: CPUs, cap 4 local / 2 in CI)",
				validate: positiveIntegerValidator("--concurrency"),
			},
			only: {
				kind: "string",
				value: "<workspaces>",
				description:
					"Check only these workspaces (path or basename, comma-separated)",
			},
			group: {
				kind: "string",
				value: "<name>",
				description: "Check one of the config's typecheck.groups (CI runners)",
			},
			changed: {
				kind: "optional",
				value: "<ref>",
				description:
					"Check only workspaces changed since the merge base with <ref> (default: origin's default branch), and their dependents",
			},
		},
		examples: [
			{
				command: "bunx buncargo typecheck",
				description: "Check every workspace plus the root config",
			},
			{
				command: "bunx buncargo typecheck --only=platform",
				description: "Check one workspace (path or basename)",
			},
			{
				command: "bunx buncargo typecheck --changed",
				description:
					"Check what this branch can break, uncommitted work included",
			},
			{
				command: "bunx buncargo typecheck --group=web",
				description: "Check one typecheck.groups selection, e.g. one CI job",
			},
			{
				command: "bunx buncargo typecheck --concurrency=2",
				description: "Cap overlapping typecheck processes",
			},
		],
	},
	exits: {
		...BASE_EXITS,
		1: "a workspace failed to typecheck, or bad arguments",
	},
	run: async ({ values }) => {
		const only = values.only === undefined ? undefined : commaList(values.only);
		const changed =
			values.changed === undefined
				? undefined
				: { ref: values.changed === true ? undefined : values.changed };
		const groupName = values.group;
		const errors: string[] = [];
		if (only?.length === 0)
			errors.push("--only requires at least one workspace name.");
		if (changed && only)
			errors.push("--changed and --only cannot be combined.");
		if (groupName && only)
			errors.push("--group and --only cannot be combined.");
		if (errors.length > 0) throw argumentsError(errors, "typecheck");
		const concurrency =
			values.concurrency === undefined
				? undefined
				: Number.parseInt(values.concurrency, 10);

		const root = (await import("../../core/ports")).findMonorepoRoot();
		// `typecheck` in dev.config.ts: directories discovery cannot see, and ones
		// to leave out.
		const settings = await (
			await import("../../typecheck/config-settings")
		).loadTypecheckConfig(root);
		if (settings.errors.length > 0) {
			log.fail(settings.errors[0] ?? "Invalid typecheck config.", [
				...settings.errors.slice(1),
			]);
		}
		if (settings.warning) log.warn(settings.warning);
		const groups = settings.config?.groups ?? {};
		const group = groupName ? groups[groupName] : undefined;
		if (groupName && !group) {
			const known = Object.keys(groups);
			log.fail(`Unknown typecheck group: ${groupName}`, [
				known.length > 0
					? `Groups in dev.config.ts: ${known.join(", ")}`
					: "Declare one under typecheck.groups in dev.config.ts.",
			]);
		}

		const { runWorkspaceTypecheck } = await import("../../typecheck");
		const { requestedTypecheckConcurrency } =
			await import("../../typecheck/scheduling");
		const { changedFilesSince } = await import("../../typecheck/changed");
		let changedFiles: string[] | undefined;
		if (changed) {
			try {
				changedFiles = changedFilesSince(root, changed.ref);
			} catch (error) {
				log.fail(getErrorMessage(error));
			}
		}

		// A machine-wide slot: typechecks from many checkouts at once exhaust memory.
		const { withCheckSlot, formatCheckSlotWait, processCheckSlot } =
			await import("../../core/check-slots");
		const { runForwardingSignals } = await import("./exec");
		const exitCode = await withCheckSlot(
			"typecheck",
			// Each check runs in its own process group, which the terminal's
			// Ctrl-C does not reach: the signal is forwarded, or every `tsc` would
			// outlive this process.
			() =>
				runForwardingSignals(async (signal) => {
					try {
						const result = await runWorkspaceTypecheck({
							root,
							verbose: true,
							concurrency: requestedTypecheckConcurrency(
								concurrency,
								settings.config?.concurrency,
							),
							only: only ?? (group?.only ? [...group.only] : undefined),
							include: settings.config?.include,
							scripts: settings.config?.scripts,
							exclude: [
								...(settings.config?.exclude ?? []),
								...(group?.exclude ?? []),
							],
							includeRootConfig: group?.rootConfig,
							changedFiles,
							signal,
						});
						return { exitCode: result.success ? 0 : 1, stdout: "", stderr: "" };
					} catch (error) {
						// Interrupted: the signal's exit code says so.
						if (signal.aborted) return { exitCode: 1, stdout: "", stderr: "" };
						throw error;
					}
				}),
			{
				...processCheckSlot,
				onWait: (wait) => log.info(formatCheckSlotWait(wait)),
			},
		);
		process.exit(exitCode);
	},
});
