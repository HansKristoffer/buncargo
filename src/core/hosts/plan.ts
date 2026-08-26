import type {
	AppConfig,
	HostsOptions,
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
	services: string[] | true;
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
	hosts: boolean | HostsOptions | undefined,
): ResolvedHostsOptions | null {
	if (!hosts) return null;
	const options = hosts === true ? {} : hosts;
	return {
		tld: sanitizeTld(options.tld ?? "localhost"),
		primaryApp: options.primaryApp,
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
	selection: string[] | true,
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
	hosts: boolean | HostsOptions;
}): NamedHost[] {
	const options = resolveHostsOptions(input.hosts);
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
			const labels = [
				...(worktreeLabel ? [worktreeLabel] : []),
				...(appLabel ? [appLabel] : []),
				projectLabel,
				...tldLabels,
			];
			plan.push({
				kind: "app",
				name,
				hostname: joinHostname(labels),
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
		const labels = [
			...(worktreeLabel ? [worktreeLabel] : []),
			sanitizeDnsLabel(name),
			projectLabel,
			...tldLabels,
		];
		plan.push({
			kind: "service",
			name,
			hostname: joinHostname(labels),
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
