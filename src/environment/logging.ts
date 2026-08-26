import pc from "picocolors";

function formatUrl(url: string): string {
	return pc.cyan(
		url.replace(/:(\d+)(\/?)/, (_, port, slash) => `:${pc.bold(port)}${slash}`),
	);
}

function formatLabel(label: string, value: string, arrow = "➜"): string {
	return `  ${pc.green(arrow)}  ${pc.bold(label.padEnd(10))} ${value}`;
}

function formatDimLabel(label: string, value: string): string {
	return `  ${pc.dim("•")}  ${pc.dim(label.padEnd(10))} ${pc.dim(value)}`;
}

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

export function logEnvironmentInfo(input: {
	label: string;
	projectName: string;
	services: Record<string, unknown>;
	apps: Record<string, unknown>;
	ports: Record<string, number>;
	urls?: Record<string, string>;
	localIp: string;
	worktree: boolean;
	portOffset: number;
	projectSuffix?: string;
	tunnels?: Array<{
		kind: "service" | "app";
		name: string;
		publicUrl: string;
		localUrl: string;
	}>;
}): void {
	const {
		label,
		projectName,
		services,
		apps,
		ports,
		urls,
		localIp,
		worktree,
		portOffset,
		projectSuffix,
		tunnels,
	} = input;
	const serviceNames = Object.keys(services);
	const appNames = Object.keys(apps);

	console.log("");
	console.log(`  ${pc.cyan(pc.bold(`🐳 ${label}`))}`);
	console.log(formatLabel("Project:", pc.white(projectName)));

	if (serviceNames.length > 0) {
		console.log("");
		console.log(`  ${pc.dim("─── Services ───")}`);
		for (const name of serviceNames) {
			const port = ports[name];
			const named = urls?.[name];
			const url = named ?? `http://localhost:${port}`;
			console.log(formatLabel(`${name}:`, formatUrl(url)));
			if (named && port !== undefined && !named.includes(`:${port}`)) {
				console.log(formatDimLabel("port:", String(port)));
			}
			const t = tunnelFor(tunnels, name, "service");
			if (t) {
				console.log(
					`       ${pc.dim("Public:")}  ${formatUrl(t.publicUrl)} ${pc.dim("(tunnel)")}`,
				);
			}
			const service = services[name] as
				| { database?: string; user?: string; password?: string }
				| undefined;
			if (name.toLowerCase().includes("postgres") || service?.database) {
				const user = service?.user ?? "postgres";
				const password = service?.password ?? "postgres";
				const database = service?.database ?? "postgres";
				if (name.toLowerCase().includes("postgres")) {
					const tablePlus = new URL(
						`postgresql://${user}:${password}@localhost:${port}/${database}`,
					);
					tablePlus.searchParams.set("env", "development");
					tablePlus.searchParams.set("name", `${projectName}-${name}`);
					tablePlus.searchParams.set("schema", "public");
					console.log(
						`       ${pc.dim("TablePlus:")} ${pc.cyan(tablePlus.toString())}`,
					);
				}
			}
		}
	}

	if (appNames.length > 0) {
		console.log("");
		console.log(`  ${pc.dim("─── Applications ───")}`);
		for (const name of appNames) {
			const port = ports[name];
			const named = urls?.[name];
			const localUrl = named ?? `http://localhost:${port}`;
			const networkUrl = `http://${localIp}:${port}`;

			console.log(`  ${pc.green("➜")}  ${pc.bold(pc.cyan(name))}`);
			console.log(`       ${pc.dim("Local:")}   ${formatUrl(localUrl)}`);
			if (named && port !== undefined) {
				console.log(`       ${pc.dim("Port:")}    ${pc.dim(String(port))}`);
			}
			console.log(`       ${pc.dim("Network:")} ${formatUrl(networkUrl)}`);
			const t = tunnelFor(tunnels, name, "app");
			if (t) {
				console.log(
					`       ${pc.dim("Public:")}  ${formatUrl(t.publicUrl)} ${pc.dim("(tunnel)")}`,
				);
			}
		}
	}

	console.log("");
	console.log(`  ${pc.dim("─── Environment ───")}`);
	console.log(formatDimLabel("Worktree:", worktree ? "yes" : "no"));
	console.log(
		formatDimLabel("Port offset:", portOffset > 0 ? `+${portOffset}` : "none"),
	);
	if (projectSuffix) {
		console.log(formatDimLabel("Suffix:", projectSuffix));
	}
	console.log(formatDimLabel("Local IP:", localIp));
	console.log("");
}
