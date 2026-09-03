import type {
	AppConfig,
	HostsOptionsLike,
	NamedHost,
	ServiceConfig,
} from "../../types";

export const RESERVED_HOST_LABELS = new Set([
	"dev",
	"typecheck",
	"prisma",
	"env",
	"ls",
	"status",
	"doctor",
	"help",
	"version",
	"hosts",
	"localhost",
]);

export const DEFAULT_HTTP_SERVICE_NAMES = new Set(["mailpit", "typesense"]);

export const TCP_SERVICE_NAMES = new Set([
	"postgres",
	"postgresql",
	"redis",
	"clickhouse",
	"mysql",
	"mongodb",
]);

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME = 253;

export interface ResolvedHostsOptions {
	tld: string;
	primaryApp?: string;
	services: readonly string[] | true;
}

export function isHostsPlatformSupported(
	platform: NodeJS.Platform = process.platform,
): boolean {
	return platform === "darwin" || platform === "linux";
}

export function sanitizeDnsLabel(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/g, "");
	if (!sanitized || !DNS_LABEL.test(sanitized)) {
		throw new Error(
			`"${value}" is not a valid DNS label. Use lowercase letters, digits, and interior hyphens (max 63).`,
		);
	}
	if (RESERVED_HOST_LABELS.has(sanitized)) {
		throw new Error(
			`"${sanitized}" is reserved and cannot be used as a hostname label.`,
		);
	}
	return sanitized;
}

export function sanitizeTld(tld: string): string {
	const normalized = tld.toLowerCase().replace(/\.$/, "");
	if (!normalized) {
		throw new Error("hosts.tld must be a non-empty DNS name");
	}
	const labels = normalized.split(".");
	for (const label of labels) {
		if (!DNS_LABEL.test(label)) {
			throw new Error(
				`hosts.tld "${tld}" is not a valid DNS name. Each label must be lowercase letters, digits, and interior hyphens.`,
			);
		}
	}
	if (normalized.length > MAX_HOSTNAME) {
		throw new Error(`hosts.tld "${tld}" exceeds the 253-character DNS limit.`);
	}
	return normalized;
}

export function resolveHostsOptions(
	hosts: boolean | HostsOptionsLike | undefined,
	/** `options.primaryApp`, which `hosts.primaryApp` still overrides. */
	primaryApp?: string,
): ResolvedHostsOptions | null {
	if (!hosts) return null;
	const options = hosts === true ? {} : hosts;
	return {
		tld: sanitizeTld(options.tld ?? "localhost"),
		primaryApp: options.primaryApp ?? primaryApp,
		services: options.services ?? [...DEFAULT_HTTP_SERVICE_NAMES],
	};
}

export function isHttpService(name: string, service: ServiceConfig): boolean {
	if (service.urlTemplate) {
		return false;
	}
	const docker = service.docker;
	const key = (docker?.kind === "preset" ? docker.preset : name).toLowerCase();
	return !TCP_SERVICE_NAMES.has(key);
}

export function selectNamedServiceKeys(
	services: Record<string, ServiceConfig>,
	selection: readonly string[] | true,
): string[] {
	if (selection === true) {
		return Object.entries(services)
			.filter(([name, service]) => isHttpService(name, service))
			.map(([name]) => name);
	}
	return selection.filter((name) => services[name] !== undefined);
}

export function joinHostname(labels: string[]): string {
	const hostname = labels.join(".");
	if (hostname.length > MAX_HOSTNAME) {
		throw new Error(
			`Hostname "${hostname}" exceeds the 253-character DNS limit.`,
		);
	}
	return hostname;
}

export function planNamedHosts(input: {
	projectPrefix: string;
	worktreeSuffix?: string | null;
	apps?: Record<string, AppConfig>;
	services: Record<string, ServiceConfig>;
	ports: Record<string, number>;
	hosts: boolean | HostsOptionsLike;
	primaryApp?: string;
}): NamedHost[] {
	const options = resolveHostsOptions(input.hosts, input.primaryApp);
	if (!options) return [];

	const projectLabel = sanitizeDnsLabel(input.projectPrefix);
	const worktreeLabel = input.worktreeSuffix
		? sanitizeDnsLabel(input.worktreeSuffix)
		: null;
	const tldLabels = options.tld.split(".");
	const plan: NamedHost[] = [];

	if (input.apps) {
		for (const name of Object.keys(input.apps)) {
			const port = input.ports[name];
			if (port === undefined) continue;
			const appLabel =
				options.primaryApp === name ? undefined : sanitizeDnsLabel(name);
			const baseLabels = [
				...(appLabel ? [appLabel] : []),
				projectLabel,
				...tldLabels,
			];
			plan.push({
				kind: "app",
				name,
				hostname: joinHostname([
					...(worktreeLabel ? [worktreeLabel] : []),
					...baseLabels,
				]),
				baseHostname: joinHostname(baseLabels),
				targetPort: port,
			});
		}
	}

	for (const name of selectNamedServiceKeys(input.services, options.services)) {
		const port = input.ports[name];
		if (port === undefined) continue;
		if (!isHttpService(name, input.services[name] as ServiceConfig)) {
			continue;
		}
		const baseLabels = [sanitizeDnsLabel(name), projectLabel, ...tldLabels];
		plan.push({
			kind: "service",
			name,
			hostname: joinHostname([
				...(worktreeLabel ? [worktreeLabel] : []),
				...baseLabels,
			]),
			baseHostname: joinHostname(baseLabels),
			targetPort: port,
		});
	}

	return plan;
}

export function applyHostPlanToUrls(
	urls: Record<string, string>,
	plan: NamedHost[],
): void {
	for (const entry of plan) {
		urls[entry.name] = `https://${entry.hostname}`;
	}
}

/**
 * The names a certificate should carry to serve `plan` and every sibling
 * worktree of the same project.
 *
 * A worktree adds a label in front (`fix-ui.api.myapp.localhost`), so each new
 * checkout produced a hostname no existing certificate covered, forcing a
 * remint. That is the expensive event: minting rebinds the daemon's listener,
 * which drops every proxied websocket on the machine — including HMR sockets
 * belonging to projects that had nothing to do with the new worktree. With
 * agents creating worktrees routinely, that was happening several times a day.
 *
 * A wildcard covers exactly one label, so both directions are needed: `*.<h>`
 * for a worktree of this hostname, and one per ancestor for a worktree of a
 * sibling. The chain stops above the TLD — `*.localhost` is both far too broad
 * and rejected by browsers, and it would let any project serve any other
 * project's name.
 */
export function certificateHostnames(plan: NamedHost[], tld: string): string[] {
	const tldLabels = sanitizeTld(tld).split(".").length;
	const names = new Set<string>();

	for (const entry of plan) {
		// Everything here comes from the *base* name, never the worktree's own
		// hostname, so every checkout of a project asks for exactly the same
		// set. Asking for `t3code-a.api.myapp.localhost` and its wildcards
		// would put a name on the request that no leaf has yet — and a missing
		// name is a remint, which is the churn this exists to remove. The
		// worktree's hostname needs no entry of its own: `*.<base>` covers it.
		const base = entry.baseHostname || entry.hostname;
		names.add(base);

		// `*.<base>` covers a worktree of this name; each ancestor down to one
		// label above the TLD covers a worktree of a sibling.
		const labels = base.split(".");
		for (let start = 0; labels.length - start >= tldLabels + 1; start++) {
			names.add(`*.${labels.slice(start).join(".")}`);
		}
	}

	return [...names].sort();
}

/**
 * Whether a certificate's SAN list covers `hostname`.
 *
 * A wildcard matches exactly one label, and only at the front — the rule
 * browsers apply — so this cannot be a substring check.
 */
export function certificateCovers(
	covered: Iterable<string>,
	hostname: string,
): boolean {
	const names = covered instanceof Set ? covered : new Set(covered);
	if (names.has(hostname)) return true;
	const dot = hostname.indexOf(".");
	if (dot === -1) return false;
	return names.has(`*.${hostname.slice(dot + 1)}`);
}
