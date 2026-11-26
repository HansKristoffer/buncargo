import { typedSwitch } from "hanzio";
import pc from "picocolors";
import { appEntryPath, withEntryPath } from "../core/app-url";
import { describeService } from "../core/service-identity";
import {
	colorizeName,
	formatClickableUrl,
	formatHyperlink,
	formatSection,
	prefixWidth,
} from "../core/style";
import type { LinkInspection, ResolvedService } from "../types";

interface BannerTunnel {
	kind: "service" | "app";
	name: string;
	publicUrl: string;
	localUrl: string;
}

function tunnelFor(
	tunnels: BannerTunnel[] | undefined,
	name: string,
	kind: BannerTunnel["kind"],
) {
	return tunnels?.find((t) => t.name === name && t.kind === kind);
}

export interface EnvironmentBannerInput {
	label: string;
	projectPrefix: string;
	projectName: string;
	worktreeSuffix?: string | null;
	services: Record<string, unknown>;
	apps: Record<string, unknown>;
	ports: Record<string, number>;
	urls?: Record<string, string>;
	localIp: string;
	portOffset: number;
	tunnels?: BannerTunnel[];
	/** Cross-repo links declared in config, shown when non-empty. */
	links?: readonly LinkInspection[];
	/** A dim hint after an app's row, from its integrations (`bunx buncargo expo sim`). */
	hintFor?: (app: string) => string | undefined;
}

export function formatBannerHeader(input: {
	label: string;
	projectPrefix: string;
	worktreeSuffix?: string | null;
	portOffset: number;
}): string {
	const bits = [`  ${pc.cyan(pc.bold("🐳"))}`];

	if (input.worktreeSuffix) {
		bits.push(colorizeName(input.worktreeSuffix));
		bits.push(pc.dim("·"));
		bits.push(pc.white(input.projectPrefix));
	} else {
		bits.push(pc.white(input.projectPrefix));
	}

	if (/production/i.test(input.label)) {
		bits.push(pc.dim("production"));
	}

	if (input.portOffset > 0) {
		bits.push(pc.dim(`+${input.portOffset}`));
	}

	return bits.join("  ");
}

function paddedName(name: string, width: number): string {
	return `${colorizeName(name)}${" ".repeat(Math.max(0, width - name.length))}`;
}

export function formatEnvironmentBanner(
	input: EnvironmentBannerInput,
): string[] {
	const {
		label,
		projectPrefix,
		projectName,
		worktreeSuffix,
		services,
		apps,
		ports,
		urls,
		localIp,
		portOffset,
		tunnels,
		links = [],
	} = input;
	const serviceNames = Object.keys(services);
	const appNames = Object.keys(apps);
	const linkNames = links.map((link) => link.name);
	const width = prefixWidth([...serviceNames, ...appNames, ...linkNames]);
	const lines: string[] = [
		"",
		formatBannerHeader({
			label,
			projectPrefix,
			worktreeSuffix,
			portOffset,
		}),
	];

	if (serviceNames.length > 0) {
		lines.push("", formatSection("Services"));
		for (const name of serviceNames) {
			const port = ports[name];
			const named = urls?.[name];
			const url =
				named ??
				(port === undefined
					? "container (no host port)"
					: `http://localhost:${port}`);
			lines.push(
				`  ${pc.green("➜")}  ${paddedName(name, width)}  ${formatClickableUrl(url)}`,
			);

			// A named URL hides the port it proxies to, so show it beside the row.
			if (named && port !== undefined && !named.includes(`:${port}`)) {
				lines.push(`       ${pc.dim(`:${port}`)}`);
			}

			const t = tunnelFor(tunnels, name, "service");
			if (t) {
				lines.push(
					`       ${pc.dim("public")}  ${formatClickableUrl(t.publicUrl)}`,
				);
			}

			// Preset, not name: a service keyed `db` from `service.postgres()`
			// is as much a database as one keyed `postgres`.
			const identity = describeService({
				name,
				service: services[name] as ResolvedService | undefined,
				port,
				projectName,
			});

			if (identity.tablePlusUrl) {
				lines.push(
					`       ${formatHyperlink(identity.tablePlusUrl, pc.cyan("TablePlus"))}`,
				);
			}
		}
	}

	if (appNames.length > 0) {
		lines.push("", formatSection("Apps"));
		for (const name of appNames) {
			const port = ports[name];
			const named = urls?.[name];
			const localUrl =
				port === undefined && !named
					? "worker"
					: (withEntryPath(
							named ?? `http://localhost:${port}`,
							appEntryPath(apps[name]),
						) ?? "worker");

			const extras: string[] = [];
			if (named && port !== undefined && !named.includes(`:${port}`)) {
				extras.push(pc.dim(`:${port}`));
			}

			if (port !== undefined && localIp !== "127.0.0.1") {
				extras.push(pc.dim(formatClickableUrl(`http://${localIp}:${port}`)));
			}

			const t = tunnelFor(tunnels, name, "app");
			if (t) {
				extras.push(formatClickableUrl(t.publicUrl));
			}

			const hint = input.hintFor?.(name);
			if (hint) {
				extras.push(pc.dim(hint));
			}

			const suffix =
				extras.length > 0 ? `  ${extras.join(pc.dim("  ·  "))}` : "";
			lines.push(
				`  ${pc.green("➜")}  ${paddedName(name, width)}  ${formatClickableUrl(localUrl)}${suffix}`,
			);
		}
	}

	if (links.length > 0) {
		lines.push("", formatSection("Links"));
		for (const item of links) {
			lines.push(formatBannerLinkLine(item, width));
		}
	}

	lines.push("");
	return lines;
}

function formatBannerLinkLine(item: LinkInspection, width: number): string {
	const name = paddedName(item.name, width);
	return typedSwitch(item.status, {
		linked: () => formatConnectedLinkLine(item, name),
		"missing-endpoints": () => formatConnectedLinkLine(item, name),
		disabled: () =>
			`  ${pc.dim("○")}  ${name}  ${pc.dim("disabled by profile")}`,
		ambiguous: () => {
			const hint = `${item.candidates.length} running, run \`buncargo links pin ${item.name} <path>\``;
			return `  ${pc.yellow("!")}  ${name}  ${pc.yellow(hint)}`;
		},
		"not-running": () => {
			if (item.pinProjectMismatch && item.pinnedRoot) {
				const mismatch = `pinned to "${item.pinProjectMismatch}", expected "${item.project}"`;
				return `  ${pc.yellow("!")}  ${name}  ${pc.yellow(mismatch)}`;
			}
			if (item.pinMissing && item.pinnedRoot) {
				const missingPin = `pinned path missing (${item.pinnedRoot})`;
				return `  ${pc.yellow("!")}  ${name}  ${pc.yellow(missingPin)}`;
			}
			const suffix = item.required
				? pc.red("not running (required)")
				: pc.dim("not running (optional)");
			return `  ${pc.dim("○")}  ${name}  ${suffix}`;
		},
	});
}

function formatConnectedLinkLine(item: LinkInspection, name: string): string {
	const link = item.link;
	if (!link) return `  ${pc.dim("○")}  ${name}  ${pc.dim(item.project)}`;
	const tag = item.source === "pinned" ? "pinned" : "auto";
	const detail = link.branch
		? `${link.projectName} (${link.branch}, ${tag})`
		: `${link.projectName} (${tag})`;
	const missingList = [...item.missingApps, ...item.missingServices].join(", ");
	const missingNote =
		item.status === "missing-endpoints"
			? pc.yellow(`  ·  missing: ${missingList}`)
			: "";
	return `  ${pc.green("➜")}  ${name}  ${pc.dim(detail)}  ${pc.dim(link.root)}${missingNote}`;
}

export function logEnvironmentInfo(input: EnvironmentBannerInput): void {
	for (const line of formatEnvironmentBanner(input)) {
		console.log(line);
	}
}
