/**
 * Cross-repo linking: resolves another buncargo repo's live run from
 * `~/.buncargo/runs.json` and per-checkout pins in `<root>/.buncargo/links.json`.
 *
 * Pure decisions live in `applyProfileLinkOverrides`, `resolveLinks`,
 * `linkStartupIssues`, `linkedPortsOf` and `pickExportedEnv`; the edge helpers
 * read `links.json` and `runs.json` and pass them in.
 */

import { resolve } from "node:path";
import { isOneOf, isString, typedSwitch } from "hanzio";
import type {
	LinkCandidate,
	LinkInspection,
	ResolvedApp,
	ResolvedLink,
	ResolvedLinkConfig,
} from "../types";
import { canonicalCheckoutPath } from "./canonical-path";
import { type CheckoutPresence, checkoutPresence } from "./checkout-presence";
import { withFileLock } from "./file-lock";
import { object, recordOf } from "./json-shape";
import { loopbackUrlPort } from "./loopback-env";
import { readJsonDocumentSync, writeJsonDocument } from "./registry-file";
import { type RunEntry, readLiveRuns, readLiveRunsSync } from "./run-registry";
import { shellQuote } from "./shell-quote";
import { projectStateFilePath } from "./state-paths";

export { applyProfileLinkOverrides } from "./link-config";

const LINKS_FILENAME = "links.json";

const isLinksDocument = object({
	version: isOneOf([1] as const),
	pins: recordOf(isString),
});

function getLinkPinsPath(root: string): string {
	return projectStateFilePath(root, LINKS_FILENAME);
}

/** Per-checkout link pins stored in `<root>/.buncargo/links.json`. */
export function readLinkPins(root: string): Record<string, string> {
	const doc = readJsonDocumentSync(getLinkPinsPath(root), (value) =>
		isLinksDocument(value) ? value : undefined,
	);
	return doc ? { ...doc.pins } : {};
}

/** Apply `set` then `unset` to `<root>/.buncargo/links.json` under its lock. */
export async function updateLinkPins(
	root: string,
	change: { set?: Record<string, string>; unset?: readonly string[] },
): Promise<Record<string, string>> {
	const path = getLinkPinsPath(root);

	return withFileLock(path, async () => {
		const pins = { ...readLinkPins(root), ...change.set };
		for (const key of change.unset ?? []) delete pins[key];

		const sorted = Object.fromEntries(
			Object.entries(pins).sort(([a], [b]) => a.localeCompare(b)),
		);

		await writeJsonDocument(path, { version: 1, pins: sorted });
		return sorted;
	});
}

interface LiveCheckoutGroup {
	readonly root: string;
	readonly projectPrefix: string;
	readonly projectName: string;
	readonly worktree: string | null;
	readonly branch?: string;
	readonly link: ResolvedLink;
	readonly unhealthyServices: ReadonlySet<string>;
}

/**
 * Merge all non-ephemeral live runs of one checkout root, oldest-to-newest so
 * newest wins. Suffixed throwaway runs (`buncargo ci`, `withSuffix()`) are
 * ignored so ephemeral ports never overwrite a checkout's real dev run.
 */
function groupLiveRunsByCheckout(
	runs: readonly RunEntry[],
	canonicalize: (path: string) => string,
): Map<string, LiveCheckoutGroup> {
	const byRoot = new Map<string, RunEntry[]>();
	for (const run of runs) {
		if (run.suffix !== undefined) continue;
		const canonical = canonicalize(run.root);
		const list = byRoot.get(canonical);
		if (list) list.push(run);
		else byRoot.set(canonical, [run]);
	}

	const groups = new Map<string, LiveCheckoutGroup>();
	for (const [root, checkoutRuns] of byRoot) {
		const ordered = [...checkoutRuns].sort((a, b) =>
			a.startedAt.localeCompare(b.startedAt),
		);
		const newest = ordered[ordered.length - 1];
		if (!newest) continue;

		const ports: Record<string, number> = {};
		const urls: Record<string, string> = {};
		const loopbackUrls: Record<string, string> = {};
		const publicUrls: Record<string, string> = {};
		const captured: Record<string, string> = {};
		const env: Record<string, string> = {};
		const appStatuses: Record<string, string> = {};
		const serviceStatuses: Record<string, string> = {};
		const unhealthyServices = new Set<string>();

		for (const run of ordered) {
			for (const app of run.apps) {
				if (app.port !== undefined) ports[app.name] = app.port;
				if (app.url !== undefined) urls[app.name] = app.url;
				if (app.loopbackUrl !== undefined) {
					loopbackUrls[app.name] = app.loopbackUrl;
				}
				if (app.publicUrl !== undefined) publicUrls[app.name] = app.publicUrl;
				appStatuses[app.name] = app.status;
			}
			for (const service of run.services) {
				if (service.port !== undefined) ports[service.name] = service.port;
				if (service.url !== undefined) urls[service.name] = service.url;
				if (service.loopbackUrl !== undefined) {
					loopbackUrls[service.name] = service.loopbackUrl;
				}
				if (service.publicUrl !== undefined) {
					publicUrls[service.name] = service.publicUrl;
				}
				serviceStatuses[service.name] =
					service.problem !== undefined ? "degraded" : service.status;
				if (service.status === "stopped" || service.problem !== undefined) {
					unhealthyServices.add(service.name);
				} else {
					unhealthyServices.delete(service.name);
				}
			}
			if (run.captures) Object.assign(captured, run.captures);
			if (run.exports) Object.assign(env, run.exports);
		}

		const branch = ordered.findLast((run) => run.branch !== undefined)?.branch;
		const link: ResolvedLink = {
			project: newest.projectPrefix,
			projectName: newest.projectName,
			root,
			worktree: newest.worktree,
			...(branch !== undefined ? { branch } : {}),
			ports,
			urls,
			loopbackUrls,
			publicUrls,
			captured,
			env,
			appStatuses,
			serviceStatuses,
		};

		groups.set(root, {
			root,
			projectPrefix: newest.projectPrefix,
			projectName: newest.projectName,
			worktree: newest.worktree,
			branch,
			link,
			unhealthyServices,
		});
	}

	return groups;
}

function missingEndpoints(
	group: LiveCheckoutGroup,
	spec: ResolvedLinkConfig,
): { missingApps: string[]; missingServices: string[] } {
	const missingApps = (spec.apps ?? []).filter((appName) => {
		const status = group.link.appStatuses[appName];
		return status !== "ready" && status !== "reused";
	});
	const missingServices = (spec.services ?? []).filter((serviceName) => {
		const status = group.link.serviceStatuses[serviceName];
		return status !== "ready" || group.unhealthyServices.has(serviceName);
	});
	return { missingApps, missingServices };
}

function toCandidate(group: LiveCheckoutGroup): LinkCandidate {
	return {
		root: group.root,
		projectName: group.projectName,
		worktree: group.worktree,
		...(group.branch !== undefined ? { branch: group.branch } : {}),
	};
}

export interface LinkResolution {
	readonly inspections: readonly LinkInspection[];
	readonly links: Readonly<Record<string, ResolvedLink | undefined>>;
}

/**
 * Pure link resolution for one checkout against the machine's live runs and
 * this checkout's pins.
 *
 * Precedence:
 * 1. Disabled by active profile → `"disabled"`
 * 2. Explicit pin in `.buncargo/links.json` → exact checkout (never falls back
 *    to another worktree's live run)
 * 3. Live checkouts matching `project` (excluding `root` itself):
 *    - 1 live checkout → `"linked"` (or `"missing-endpoints"`)
 *    - 2+ live checkouts → `"ambiguous"` (never guesses silently)
 *    - 0 live checkouts → `"not-running"`
 */
export function resolveLinks(input: {
	root: string;
	links?: Readonly<Record<string, ResolvedLinkConfig>>;
	pins: Readonly<Record<string, string>>;
	liveRuns: readonly RunEntry[];
	checkoutPresence: (path: string) => CheckoutPresence;
	canonicalize: (path: string) => string;
}): LinkResolution {
	const specs = input.links;
	if (!specs || Object.keys(specs).length === 0) {
		return { inspections: [], links: {} };
	}

	const { canonicalize } = input;
	const ownRoot = canonicalize(input.root);
	const groups = groupLiveRunsByCheckout(input.liveRuns, canonicalize);

	const inspections: LinkInspection[] = [];
	const resolvedMap: Record<string, ResolvedLink | undefined> = {};

	for (const [name, spec] of Object.entries(specs)) {
		const required = spec.required === true;
		const configuredPath = spec.path
			? canonicalize(resolve(ownRoot, spec.path))
			: undefined;
		const rawPin = input.pins[name];
		const pinnedRoot = rawPin ? canonicalize(rawPin) : undefined;

		if (spec.disabled) {
			resolvedMap[name] = undefined;
			inspections.push({
				name,
				project: spec.project,
				status: "disabled",
				required: false,
				source: pinnedRoot ? "pinned" : "none",
				...(pinnedRoot ? { pinnedRoot } : {}),
				...(configuredPath ? { configuredPath } : {}),
				missingApps: [],
				missingServices: [],
				candidates: [],
			});
			continue;
		}

		if (pinnedRoot) {
			const pinMissing = input.checkoutPresence(pinnedRoot) === "deleted";
			const candidate =
				pinnedRoot === ownRoot ? undefined : groups.get(pinnedRoot);
			const wrongProject =
				candidate !== undefined && candidate.projectPrefix !== spec.project;
			const group = wrongProject ? undefined : candidate;
			if (!group) {
				resolvedMap[name] = undefined;
				inspections.push({
					name,
					project: spec.project,
					status: "not-running",
					required,
					source: "pinned",
					pinnedRoot,
					pinMissing,
					...(wrongProject
						? { pinProjectMismatch: candidate.projectPrefix }
						: {}),
					...(configuredPath ? { configuredPath } : {}),
					targetRoot: pinnedRoot,
					missingApps: [...(spec.apps ?? [])],
					missingServices: [...(spec.services ?? [])],
					candidates: [],
				});
				continue;
			}

			const { missingApps, missingServices } = missingEndpoints(group, spec);
			const complete = missingApps.length === 0 && missingServices.length === 0;
			resolvedMap[name] = group.link;
			inspections.push({
				name,
				project: spec.project,
				status: complete ? "linked" : "missing-endpoints",
				required,
				source: "pinned",
				pinnedRoot,
				pinMissing: false,
				...(configuredPath ? { configuredPath } : {}),
				targetRoot: group.root,
				link: group.link,
				missingApps,
				missingServices,
				candidates: [],
			});
			continue;
		}

		const matching = [...groups.values()]
			.filter(
				(group) =>
					group.projectPrefix === spec.project && group.root !== ownRoot,
			)
			.sort((a, b) => a.root.localeCompare(b.root));

		if (matching.length === 1) {
			const [group] = matching;
			if (!group) continue;
			const { missingApps, missingServices } = missingEndpoints(group, spec);
			const complete = missingApps.length === 0 && missingServices.length === 0;
			resolvedMap[name] = group.link;
			inspections.push({
				name,
				project: spec.project,
				status: complete ? "linked" : "missing-endpoints",
				required,
				source: "auto",
				...(configuredPath ? { configuredPath } : {}),
				targetRoot: group.root,
				link: group.link,
				missingApps,
				missingServices,
				candidates: [],
			});
			continue;
		}

		if (matching.length > 1) {
			resolvedMap[name] = undefined;
			inspections.push({
				name,
				project: spec.project,
				status: "ambiguous",
				required,
				source: "none",
				...(configuredPath ? { configuredPath } : {}),
				missingApps: [],
				missingServices: [],
				candidates: matching.map(toCandidate),
			});
			continue;
		}

		const defaultTarget =
			configuredPath && input.checkoutPresence(configuredPath) === "present"
				? configuredPath
				: undefined;
		resolvedMap[name] = undefined;
		inspections.push({
			name,
			project: spec.project,
			status: "not-running",
			required,
			source: "none",
			...(configuredPath ? { configuredPath } : {}),
			...(defaultTarget ? { targetRoot: defaultTarget } : {}),
			missingApps: [...(spec.apps ?? [])],
			missingServices: [...(spec.services ?? [])],
			candidates: [],
		});
	}

	return { inspections, links: resolvedMap };
}

function formatCandidate(candidate: LinkCandidate): string {
	const label = candidate.branch ?? candidate.worktree ?? "main";
	return `${candidate.root} (${label})`;
}

/**
 * Actionable startup errors and warnings for a checkout's resolved links.
 * Required links block startup when missing, ambiguous or incomplete; optional
 * links warn only when ambiguous, pinned to a deleted directory, or pinned to
 * a checkout running a different project.
 */
export function linkStartupIssues(inspections: readonly LinkInspection[]): {
	errors: string[];
	warnings: string[];
} {
	const errors: string[] = [];
	const warnings: string[] = [];

	for (const item of inspections) {
		typedSwitch(item.status, {
			disabled: () => {},
			linked: () => {},
			ambiguous: () => {
				const choices = item.candidates.map(formatCandidate).join(", ");
				const [first] = item.candidates;
				const examplePath = first ? shellQuote(first.root) : "<path>";
				const pinCmd = `bunx buncargo links pin ${item.name} ${examplePath}`;
				const message = `Link "${item.name}" (project "${item.project}") matched ${item.candidates.length} running checkouts: ${choices}. Pin one with \`${pinCmd}\`.`;
				if (item.required) errors.push(message);
				else warnings.push(message);
			},
			"not-running": () => {
				if (item.pinProjectMismatch && item.pinnedRoot) {
					const message = `Link "${item.name}" expects project "${item.project}", but ${item.pinnedRoot} is running "${item.pinProjectMismatch}". Run \`bunx buncargo links unpin ${item.name}\` or pin a "${item.project}" checkout.`;
					if (item.required) errors.push(message);
					else warnings.push(message);
					return;
				}
				if (item.pinMissing && item.pinnedRoot) {
					const message = `Link "${item.name}" (project "${item.project}") is pinned to ${item.pinnedRoot}, which does not exist. Run \`bunx buncargo links unpin ${item.name}\` or pin another checkout.`;
					if (item.required) errors.push(message);
					else warnings.push(message);
					return;
				}
				if (!item.required) return;

				const where = item.targetRoot ? ` in ${item.targetRoot}` : "";
				const startHint = item.targetRoot
					? `Start it with \`cd ${shellQuote(item.targetRoot)} && bunx buncargo dev --detach\`, or pin another checkout with \`bunx buncargo links pin ${item.name} <path>\`.`
					: `Start a checkout of "${item.project}" with \`bunx buncargo dev --detach\`, or pin one with \`bunx buncargo links pin ${item.name} <path>\`.`;
				errors.push(
					`Required link "${item.name}" (project "${item.project}") is not running${where}. ${startHint}`,
				);
			},
			"missing-endpoints": () => {
				if (!item.required) return;
				const parts: string[] = [];
				if (item.missingApps.length > 0) {
					parts.push(`apps: ${item.missingApps.join(", ")}`);
				}
				if (item.missingServices.length > 0) {
					parts.push(`services: ${item.missingServices.join(", ")}`);
				}
				const allStarting =
					item.link !== undefined &&
					item.missingApps.every(
						(name) => item.link?.appStatuses[name] === "starting",
					) &&
					item.missingServices.every(
						(name) => item.link?.serviceStatuses[name] === "starting",
					);
				const location = item.targetRoot ?? item.project;
				if (allStarting) {
					errors.push(
						`Required link "${item.name}" (${location}) is still starting ${parts.join("; ")}. Wait for it with \`cd ${shellQuote(location)} && bunx buncargo wait\` before starting.`,
					);
					return;
				}
				const startApps =
					item.missingApps.length > 0
						? `bunx buncargo dev --detach ${item.missingApps.join(" ")}`
						: "bunx buncargo dev --detach";
				errors.push(
					`Required link "${item.name}" (${location}) is running without expected ${parts.join("; ")}. Start them in ${location} with \`${startApps}\`.`,
				);
			},
		});
	}

	return { errors, warnings };
}

/** Bare `host:port` (e.g. `127.0.0.1:8080`, `localhost:9099`) for emulator hosts. */
const LOOPBACK_HOST_PORT =
	/^(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{1,5})$/i;

/**
 * Every port owned by a live linked checkout: its apps, services and any
 * loopback `host:port` or URL in its exported env (e.g. Firebase emulators).
 * Used to keep `strayLoopbackUrls` and `buildEnvFingerprint` accurate.
 */
export function linkedPortsOf(
	links: Readonly<Record<string, ResolvedLink | undefined>>,
): Set<number> {
	const ports = new Set<number>();
	for (const link of Object.values(links)) {
		if (!link) continue;
		for (const port of Object.values(link.ports)) ports.add(port);
		for (const value of Object.values(link.env)) {
			const urlPort = loopbackUrlPort(value);
			if (urlPort !== undefined) {
				ports.add(urlPort);
				continue;
			}
			const match = LOOPBACK_HOST_PORT.exec(value.trim());
			if (match) ports.add(Number(match[1]));
		}
	}
	return ports;
}

/** Pick only the explicitly allow-listed non-secret keys for publishing to `runs.json`. */
export function pickExportedEnv(
	vars: Readonly<Record<string, string>>,
	keys: readonly string[] | undefined,
): Record<string, string> {
	if (!keys || keys.length === 0) return {};
	const exported: Record<string, string> = {};
	for (const key of keys) {
		const value = vars[key];
		if (value !== undefined) exported[key] = value;
	}
	return exported;
}

/** Resolve links against an already-fetched set of live runs (zero extra `runs.json` reads). */
export function resolveLinksFromRuns(
	root: string,
	links: Readonly<Record<string, ResolvedLinkConfig>> | undefined,
	liveRuns: readonly RunEntry[],
): LinkResolution {
	if (!links || Object.keys(links).length === 0) {
		return { inspections: [], links: {} };
	}
	return resolveLinks({
		root,
		links,
		pins: readLinkPins(root),
		liveRuns,
		checkoutPresence,
		canonicalize: (path) => canonicalCheckoutPath(path),
	});
}

/** Synchronous live link resolution, for `getEnvVar`, `buildEnvVars` and `env.links`. */
export function resolveLiveLinksSync(
	root: string,
	links: Readonly<Record<string, ResolvedLinkConfig>> | undefined,
): LinkResolution {
	if (!links || Object.keys(links).length === 0) {
		return { inspections: [], links: {} };
	}
	return resolveLinksFromRuns(root, links, readLiveRunsSync());
}

/** Async live link resolution, for `buncargo links`, `doctor` and `prepare()`. */
export async function resolveLiveLinksAsync(
	root: string,
	links: Readonly<Record<string, ResolvedLinkConfig>> | undefined,
): Promise<LinkResolution> {
	if (!links || Object.keys(links).length === 0) {
		return { inspections: [], links: {} };
	}
	const liveRuns = await readLiveRuns();
	return resolveLinksFromRuns(root, links, liveRuns);
}

function sortedRecord<T>(
	record: Readonly<Record<string, T>>,
): Record<string, T> {
	return Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
	);
}

/**
 * Stable fingerprint of a linked checkout's settled state, or `undefined`
 * while the linked checkout is mid-startup (`"starting"` or claimed with no
 * apps/services yet). Ignoring in-transition snapshots prevents dependent apps
 * from restarting prematurely before the linked repo finishes booting.
 */
export function linkReadyFingerprint(
	link: ResolvedLink | undefined,
	spec: ResolvedLinkConfig,
): string | undefined {
	if (spec.disabled) return "disabled";
	if (!link) return "down";

	const appEntries = Object.entries(link.appStatuses);
	const serviceEntries = Object.entries(link.serviceStatuses);
	if (appEntries.length === 0 && serviceEntries.length === 0) {
		return undefined;
	}

	const expectedApps = spec.apps ?? [];
	const expectedServices = spec.services ?? [];
	const anyStarting =
		appEntries.some(([, status]) => status === "starting") ||
		serviceEntries.some(([, status]) => status === "starting");

	if (expectedApps.length > 0 || expectedServices.length > 0) {
		for (const appName of expectedApps) {
			const status = link.appStatuses[appName];
			if (status === "starting" || (status === undefined && anyStarting)) {
				return undefined;
			}
			if (status !== "ready" && status !== "reused") return "incomplete";
		}
		for (const serviceName of expectedServices) {
			const status = link.serviceStatuses[serviceName];
			if (status === "starting" || (status === undefined && anyStarting)) {
				return undefined;
			}
			if (status !== "ready") return "incomplete";
		}
	} else if (anyStarting) {
		return undefined;
	}

	return JSON.stringify({
		root: link.root,
		ports: sortedRecord(link.ports),
		urls: sortedRecord(link.urls),
		loopbackUrls: sortedRecord(link.loopbackUrls),
		publicUrls: sortedRecord(link.publicUrls),
		captured: sortedRecord(link.captured),
		env: sortedRecord(link.env),
	});
}

/**
 * Apps that should restart when `changedAliases` update: every app whose
 * `restartOn` includes `links.<alias>`, plus every app when that link sets
 * `onChange: "restart"`.
 */
export function appsToRestartForLinks(
	apps: Readonly<Record<string, Pick<ResolvedApp, "restartOn">>>,
	linksConfig: Readonly<Record<string, ResolvedLinkConfig>> | undefined,
	changedAliases: readonly string[],
): { app: string; links: string[] }[] {
	if (!linksConfig || changedAliases.length === 0) return [];
	const restartAllLinks = changedAliases.filter(
		(alias) =>
			!linksConfig[alias]?.disabled &&
			linksConfig[alias]?.onChange === "restart",
	);

	const results: { app: string; links: string[] }[] = [];
	for (const [appName, app] of Object.entries(apps)) {
		const matched = new Set<string>(restartAllLinks);
		for (const alias of changedAliases) {
			if (linksConfig[alias]?.disabled) continue;
			if (app.restartOn?.includes(`links.${alias}`)) matched.add(alias);
		}
		if (matched.size > 0) {
			results.push({ app: appName, links: [...matched] });
		}
	}
	return results;
}

/** Whether any app in `apps` reacts to changes in `linksConfig`. */
export function hasReactiveLinks(
	apps: Readonly<Record<string, Pick<ResolvedApp, "restartOn">>>,
	linksConfig: Readonly<Record<string, ResolvedLinkConfig>> | undefined,
): boolean {
	if (!linksConfig) return false;
	const activeAliases = Object.entries(linksConfig)
		.filter(([, spec]) => !spec.disabled)
		.map(([alias]) => alias);
	if (activeAliases.length === 0) return false;
	return appsToRestartForLinks(apps, linksConfig, activeAliases).length > 0;
}
