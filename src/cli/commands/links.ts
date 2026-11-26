import { statSync } from "node:fs";
import { resolve } from "node:path";
import { getErrorMessage, typedSwitch } from "hanzio";
import {
	canonicalCheckoutPath,
	linkStartupIssues,
	resolveLinksFromRuns,
	resolveLiveLinksAsync,
	updateLinkPins,
} from "../../core/links";
import { readLiveRuns } from "../../core/run-registry";
import { internalsOf } from "../../environment";
import type { LinkInspection } from "../../types";
import { BASE_EXITS, defineCommand, defineGroup } from "../command-spec";
import { CliError } from "../errors";
import type { LinksJson } from "../json-documents";
import * as log from "../log";
import { loadEnv } from "./load-env";

/**
 * `buncargo links`: inspect cross-repo links declared in `dev.config.ts`,
 * pin a link to a specific checkout/worktree (`links pin <name> <path>`), or
 * clear a pin (`links unpin <name>`).
 */

function notRunningLabel(item: LinkInspection): string {
	if (item.pinProjectMismatch) {
		return `wrong project (running "${item.pinProjectMismatch}")`;
	}
	if (item.pinMissing) return "not running (pinned path missing)";
	if (item.source === "pinned") return "not running (pinned)";
	return "not running";
}

function statusLabel(item: LinkInspection): string {
	return typedSwitch(item.status, {
		linked: () => `linked (${item.source})`,
		"not-running": () => notRunningLabel(item),
		ambiguous: () => `ambiguous (${item.candidates.length} running)`,
		"missing-endpoints": () => `missing endpoints (${item.source})`,
		disabled: () => "disabled (profile)",
	});
}

function formatLinkTarget(item: LinkInspection): string {
	if (item.link) {
		const branchNote = item.link.branch ? ` (${item.link.branch})` : "";
		return `${item.link.projectName}${branchNote}  ${item.link.root}`;
	}
	return item.targetRoot ?? `project "${item.project}"`;
}

function printLinks(doc: LinksJson): void {
	if (doc.links.length === 0) {
		log.info("No cross-repo links configured in dev.config.ts.");
		return;
	}

	const nameWidth = Math.max(...doc.links.map((item) => item.name.length));
	for (const item of doc.links) {
		const tag = item.required ? " [required]" : "";
		const target = formatLinkTarget(item);
		log.line(
			`  ${item.name.padEnd(nameWidth)}  ${statusLabel(item)}${tag}  ${target}`,
		);

		if (item.link) {
			const urls = Object.entries(item.link.urls);
			if (urls.length > 0) {
				log.line(`    urls: ${urls.map(([k, v]) => `${k}=${v}`).join(", ")}`);
			}
			const envKeys = Object.keys(item.link.env);
			if (envKeys.length > 0) {
				log.line(`    env:  ${envKeys.join(", ")}`);
			}
		}

		if (item.missingApps.length > 0) {
			log.line(`    missing apps: ${item.missingApps.join(", ")}`);
		}
		if (item.missingServices.length > 0) {
			log.line(`    missing services: ${item.missingServices.join(", ")}`);
		}
		if (item.status === "ambiguous") {
			for (const candidate of item.candidates) {
				const label = candidate.branch ?? candidate.worktree ?? "main";
				log.line(`    candidate: ${candidate.root} (${label})`);
			}
			const [first] = item.candidates;
			const examplePath = first ? first.root : "<path>";
			log.hint(
				`Pin one: \`bunx buncargo links pin ${item.name} ${examplePath}\``,
			);
		}
		if (item.pinProjectMismatch && item.pinnedRoot) {
			log.hint(
				`Pinned checkout ${item.pinnedRoot} is running "${item.pinProjectMismatch}", not "${item.project}": \`bunx buncargo links unpin ${item.name}\``,
			);
		} else if (item.pinMissing && item.pinnedRoot) {
			log.hint(
				`Pinned path ${item.pinnedRoot} no longer exists: \`bunx buncargo links unpin ${item.name}\``,
			);
		}
	}
}

const showLinksCommand = defineCommand({
	spec: {
		name: "links",
		summary:
			"Show cross-repo links, their live targets, URLs, and exported env",
		flags: {
			json: { kind: "boolean", description: "One JSON document on stdout" },
			profile: {
				kind: "string",
				value: "<name>",
				description:
					"Apply a profile's link overrides (default: the profile named default)",
			},
			check: {
				kind: "boolean",
				description:
					"Exit 1 if any required link is unavailable or any link is ambiguous",
			},
		},
	},
	exits: {
		...BASE_EXITS,
		1: "bad arguments, or (--check) a required link is unavailable or ambiguous",
	},
	json: "LinksJson (--json)",
	run: async ({ values }) => {
		const env = await loadEnv({ profile: values.profile });
		const { inspections } = await resolveLiveLinksAsync(
			env.root,
			internalsOf(env).linksConfig,
		);
		const issues = linkStartupIssues(inspections);
		const doc: LinksJson = {
			version: 1,
			root: env.root,
			project: env.projectName,
			links: [...inspections],
			errors: issues.errors,
			warnings: issues.warnings,
		};

		if (values.json) log.line(JSON.stringify(doc, null, 2));
		else printLinks(doc);

		if (values.check) {
			const hasAmbiguous = inspections.some(
				(item) => item.status === "ambiguous",
			);
			if (issues.errors.length > 0 || hasAmbiguous) {
				if (!values.json) {
					for (const error of issues.errors) log.error(error);
					for (const warning of issues.warnings) log.warn(warning);
				}
				return 1;
			}
		}

		return 0;
	},
});

const pinLinkCommand = defineCommand({
	spec: {
		name: "links pin",
		summary: "Pin a configured link to a specific checkout or worktree path",
		flags: {},
		args: [
			{
				name: "<name>",
				description: "Link alias from dev.config.ts (links.<name>)",
				required: true,
			},
			{
				name: "<path>",
				description: "Path to the linked checkout or Git worktree",
				required: true,
			},
		],
		examples: [
			{
				command: "bunx buncargo links pin backend ../backend",
				description: "Pin the backend link to a sibling checkout",
			},
			{
				command:
					"bunx buncargo links pin backend ~/.t3/worktrees/backend/feature-x",
				description: "Pair this worktree with a specific backend worktree",
			},
		],
	},
	exits: BASE_EXITS,
	run: async ({ positionals: [name, targetPath] }) => {
		const env = await loadEnv();
		const configured = internalsOf(env).linksConfig;
		const spec = configured?.[name];
		if (!spec) {
			const available = Object.keys(configured ?? {});
			throw new CliError(
				`Unknown link "${name}".`,
				available.length > 0
					? [`Configured links: ${available.join(", ")}`]
					: ["Declare links in dev.config.ts under `links: { ... }`."],
			);
		}

		const resolved = resolve(process.cwd(), targetPath);
		let isDirectory = false;
		try {
			isDirectory = statSync(resolved).isDirectory();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				throw new CliError(
					`Cannot inspect directory ${resolved}: ${getErrorMessage(error)}`,
				);
			}
		}
		if (!isDirectory) {
			throw new CliError(`Directory not found: ${resolved}`, [
				"Pass the root directory of the linked checkout or worktree.",
			]);
		}

		const canonicalTarget = canonicalCheckoutPath(resolved);
		const canonicalSelf = canonicalCheckoutPath(env.root);
		if (canonicalTarget === canonicalSelf) {
			throw new CliError(
				`Cannot pin link "${name}" to this checkout itself (${canonicalSelf}).`,
			);
		}

		const liveRuns = await readLiveRuns();
		const runningAtTarget = liveRuns.find(
			(run) =>
				run.suffix === undefined &&
				canonicalCheckoutPath(run.root) === canonicalTarget,
		);
		if (runningAtTarget && runningAtTarget.projectPrefix !== spec.project) {
			throw new CliError(
				`Cannot pin link "${name}" (expects project "${spec.project}") to ${canonicalTarget}: that checkout is running "${runningAtTarget.projectPrefix}".`,
			);
		}

		await updateLinkPins(env.root, { set: { [name]: canonicalTarget } });

		const { inspections } = resolveLinksFromRuns(
			env.root,
			configured,
			liveRuns,
		);
		const current = inspections.find((item) => item.name === name);

		log.done(`Pinned link "${name}" -> ${canonicalTarget}`);
		if (current?.status === "disabled") {
			log.info(
				`Link "${name}" is currently disabled by the active profile; the pin applies whenever a profile enables it.`,
			);
		} else if (current?.link) {
			const branchNote = current.link.branch ? ` (${current.link.branch})` : "";
			log.info(
				`Connected to live run ${current.link.projectName}${branchNote}.`,
			);
		} else {
			log.hint(
				`No live run of "${spec.project}" found there yet. Start it with \`cd ${canonicalTarget} && bunx buncargo dev --detach\`.`,
			);
		}
		log.hint(
			"Applies from the next run, exec, task, or `buncargo restart <app>`.",
		);
		return 0;
	},
});

const unpinLinkCommand = defineCommand({
	spec: {
		name: "links unpin",
		summary: "Clear pinned checkout path(s) and return to auto-discovery",
		flags: {},
		args: [
			{
				name: "<name>",
				description: "Link alias(es) to unpin",
				required: true,
				variadic: true,
			},
		],
		examples: [
			{
				command: "bunx buncargo links unpin backend",
				description: "Clear the pinned path for backend",
			},
		],
	},
	exits: BASE_EXITS,
	run: async ({ positionals }) => {
		const env = await loadEnv();
		await updateLinkPins(env.root, { unset: [...positionals] });
		log.done(`Unpinned ${positionals.join(", ")} for ${env.root}`);
		log.hint(
			"Auto-discovery applies from the next run, exec, task, or `buncargo restart <app>`.",
		);
		return 0;
	},
});

export const linksCommand = defineGroup({
	spec: {
		name: "links",
		usage: "links [options] | links pin|unpin",
		summary:
			"Inspect cross-repo links, or pin a link to a specific checkout/worktree",
	},
	subcommands: { pin: pinLinkCommand, unpin: unpinLinkCommand },
	fallback: showLinksCommand,
});
