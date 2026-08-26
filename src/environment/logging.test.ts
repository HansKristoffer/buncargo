import { describe, expect, it } from "bun:test";
import { formatBannerHeader, formatEnvironmentBanner } from "./logging";

function visible(text: string): string {
	const esc = String.fromCharCode(27);
	return text.split(esc).reduce((out, part, index) => {
		if (index === 0) return part;
		if (part.startsWith("]8;;")) return out;
		if (part.startsWith("\\")) return `${out}${part.slice(1)}`;
		const end = part.indexOf("m");
		return end === -1 ? `${out}${part}` : `${out}${part.slice(end + 1)}`;
	}, "");
}

function visibleLines(input: Parameters<typeof formatEnvironmentBanner>[0]) {
	return formatEnvironmentBanner(input).map(visible);
}

describe("formatBannerHeader", () => {
	it("puts the worktree name first so stacked terminals are scannable", () => {
		expect(
			visible(
				formatBannerHeader({
					label: "Dev Environment",
					projectPrefix: "gey",
					worktreeSuffix: "feature-auth",
					portOffset: 8700,
				}),
			),
		).toBe("  🐳  feature-auth  ·  gey  +8700");
	});

	it("omits worktree chrome on the main checkout", () => {
		expect(
			visible(
				formatBannerHeader({
					label: "Dev Environment",
					projectPrefix: "gey",
					portOffset: 8700,
				}),
			),
		).toBe("  🐳  gey  +8700");
	});
});

describe("formatEnvironmentBanner", () => {
	it("keeps postgres and TablePlus on a compact two-line service row", () => {
		const lines = visibleLines({
			label: "Dev Environment",
			projectPrefix: "buncargo-playground",
			projectName: "buncargo-playground-playground",
			services: { postgres: { database: "playground" } },
			apps: {
				api: { port: 3010 },
				web: { port: 5199 },
			},
			ports: { postgres: 13233, api: 10810, web: 12999 },
			urls: {
				postgres: "postgresql://postgres:postgres@localhost:13233/playground",
				api: "http://localhost:10810",
				web: "http://localhost:12999",
			},
			localIp: "172.20.10.14",
			portOffset: 7800,
		});

		expect(lines).toContain("  🐳  buncargo-playground  +7800");
		expect(lines.some((line) => line.includes("Worktree:"))).toBe(false);
		expect(lines.some((line) => line.includes("Port offset:"))).toBe(false);
		expect(
			lines.some((line) =>
				line.includes(
					"postgresql://postgres:postgres@localhost:13233/playground",
				),
			),
		).toBe(true);
		expect(lines).toContain("       TablePlus");
		expect(lines.some((line) => line.includes("schema=public"))).toBe(false);
		expect(
			lines.some(
				(line) =>
					line.includes("api") && line.includes("http://localhost:10810"),
			),
		).toBe(true);
		expect(
			lines.some((line) => line.includes("http://172.20.10.14:10810")),
		).toBe(true);
	});

	it("wraps TablePlus as a short hyperlink to the connection URL", () => {
		const raw = formatEnvironmentBanner({
			label: "Dev Environment",
			projectPrefix: "app",
			projectName: "app-app",
			services: { postgres: { database: "app" } },
			apps: {},
			ports: { postgres: 5432 },
			localIp: "127.0.0.1",
			portOffset: 0,
		}).join("\n");
		expect(raw).toContain(`${String.fromCharCode(27)}]8;;postgresql://`);
		expect(raw).toContain("tLSMode=0");
		expect(visible(raw)).toContain("TablePlus");
	});
});
