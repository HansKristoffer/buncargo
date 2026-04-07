import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDevConfig } from "../config";
import { createDevEnvironment } from "./create-dev-environment";

const originalCwd = process.cwd();

function createTempRoot(): string {
	const root = join(
		tmpdir(),
		`buncargo-open-tunnel-${Date.now()}-${Math.random()}`,
	);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(join(root, ".git"), "gitdir: /tmp/repo");
	return root;
}

describe("openPublicTunnels", () => {
	it("throws for unknown expose name", async () => {
		const root = createTempRoot();
		try {
			process.chdir(root);
			const dev = createDevEnvironment(
				defineDevConfig({
					projectPrefix: "otest",
					services: {
						postgres: { port: 5432 },
					},
					apps: {
						api: {
							port: 3000,
							devCommand: "bun run dev",
							expose: true,
						},
					},
				}),
			);

			await expect(dev.openPublicTunnels({ names: ["nope"] })).rejects.toThrow(
				/Unknown expose target/,
			);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws when target is not expose-enabled", async () => {
		const root = createTempRoot();
		try {
			process.chdir(root);
			const dev = createDevEnvironment(
				defineDevConfig({
					projectPrefix: "otest",
					services: {
						postgres: { port: 5432 },
					},
					apps: {
						api: {
							port: 3000,
							devCommand: "bun run dev",
							expose: true,
						},
						web: {
							port: 5173,
							devCommand: "bun run dev",
						},
					},
				}),
			);

			await expect(dev.openPublicTunnels({ names: ["web"] })).rejects.toThrow(
				/missing expose: true/,
			);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws for unknown waitForHealthy app name", async () => {
		const root = createTempRoot();
		try {
			process.chdir(root);
			const dev = createDevEnvironment(
				defineDevConfig({
					projectPrefix: "otest",
					services: {
						postgres: { port: 5432 },
					},
					apps: {
						api: {
							port: 3000,
							devCommand: "bun run dev",
							expose: true,
						},
					},
				}),
			);

			await expect(
				dev.openPublicTunnels({ waitForHealthy: ["nope"] }),
			).rejects.toThrow(/Unknown app name/);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws when no expose targets are configured", async () => {
		const root = createTempRoot();
		try {
			process.chdir(root);
			const dev = createDevEnvironment(
				defineDevConfig({
					projectPrefix: "otest",
					services: {
						postgres: { port: 5432 },
					},
					apps: {
						api: {
							port: 3000,
							devCommand: "bun run dev",
						},
					},
				}),
			);

			await expect(dev.openPublicTunnels()).rejects.toThrow(
				/No expose targets selected/,
			);
		} finally {
			process.chdir(originalCwd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
