import pc from "picocolors";
import { describeService } from "../core/service-identity";
import {
	colorizeName,
	formatClickableUrl,
	formatHyperlink,
	formatSection,
	prefixWidth,
} from "../core/style";
import type { ServiceConfig } from "../types";

function tunnelFor(
	tunnels:
		| Array<{
				kind: "service" | "app";
				name: string;
				publicUrl: string;
				localUrl: string;
		  }>
		| undefined,
	name: string,
	kind: "service" | "app",
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
	tunnels?: Array<{
		kind: "service" | "app";
		name: string;
		publicUrl: string;
		localUrl: string;
	}>;
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
	} = input;
	const serviceNames = Object.keys(services);
	const appNames = Object.keys(apps);
	const width = prefixWidth([...serviceNames, ...appNames]);
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
			const url = named ?? `http://localhost:${port}`;
			lines.push(
				`  ${pc.green("➜")}  ${paddedName(name, width)}  ${formatClickableUrl(url)}`,
			);
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
				service: services[name] as ServiceConfig | undefined,
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
			const localUrl = named ?? `http://localhost:${port}`;
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
			const suffix =
				extras.length > 0 ? `  ${extras.join(pc.dim("  ·  "))}` : "";
			lines.push(
				`  ${pc.green("➜")}  ${paddedName(name, width)}  ${formatClickableUrl(localUrl)}${suffix}`,
			);
		}
	}

	lines.push("");
	return lines;
}

export function logEnvironmentInfo(input: EnvironmentBannerInput): void {
	for (const line of formatEnvironmentBanner(input)) {
		console.log(line);
	}
}
