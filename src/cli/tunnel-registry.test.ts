import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadReusableTunnelApps,
	pruneTunnelRegistry,
	removeTunnelRegistryEntries,
	upsertTunnelRegistryEntries,
} from "./tunnel-registry";

const cleanupPaths: string[] = [];

afterEach(async () => {
	while (cleanupPaths.length > 0) {
		const path = cleanupPaths.pop();
		if (path) {
			await rm(path, { recursive: true, force: true });
		}
	}
});

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "buncargo-tunnel-registry-"));
	cleanupPaths.push(root);
	return root;
}

describe("tunnel registry", () => {
	it("stores and loads reusable app public URLs", async () => {
		const root = await createTempRoot();
		await upsertTunnelRegistryEntries(root, [
			{
				kind: "app",
				name: "api",
				publicUrl: "https://api.example.com",
				localUrl: "http://localhost:3000",
				port: 3000,
				pid: process.pid,
				updatedAt: new Date().toISOString(),
			},
		]);

		const result = await loadReusableTunnelApps(root, {
			appNames: ["api"],
			ports: { api: 3000 },
		});

		expect(result.publicUrls).toEqual({
			api: "https://api.example.com",
		});
		expect(result.tunnels).toEqual([
			{
				kind: "app",
				name: "api",
				publicUrl: "https://api.example.com",
				localUrl: "http://localhost:3000",
			},
		]);
		expect(result.missingAppNames).toEqual([]);
	});

	it("prunes stale entries", async () => {
		const root = await createTempRoot();
		await upsertTunnelRegistryEntries(root, [
			{
				kind: "app",
				name: "api",
				publicUrl: "https://api.example.com",
				localUrl: "http://localhost:3000",
				port: 3000,
				pid: process.pid,
				updatedAt: new Date(0).toISOString(),
			},
		]);

		const activeEntries = await pruneTunnelRegistry(root);
		const result = await loadReusableTunnelApps(root, {
			appNames: ["api"],
			ports: { api: 3000 },
		});

		expect(activeEntries).toEqual([]);
		expect(result.publicUrls).toEqual({});
		expect(result.missingAppNames).toEqual(["api"]);
	});

	it("removes owned entries on cleanup", async () => {
		const root = await createTempRoot();
		await upsertTunnelRegistryEntries(root, [
			{
				kind: "app",
				name: "api",
				publicUrl: "https://api.example.com",
				localUrl: "http://localhost:3000",
				port: 3000,
				pid: process.pid,
				updatedAt: new Date().toISOString(),
			},
		]);

		await removeTunnelRegistryEntries(root, [
			{
				kind: "app",
				name: "api",
				pid: process.pid,
			},
		]);

		const result = await loadReusableTunnelApps(root, {
			appNames: ["api"],
			ports: { api: 3000 },
		});

		expect(result.publicUrls).toEqual({});
		expect(result.missingAppNames).toEqual(["api"]);
	});
});
