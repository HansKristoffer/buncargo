import { expect, it } from "bun:test";
import type { RunEntry } from "../core/run-registry";
import { TailnetUnavailableError } from "../core/tailnet/client";
import { createTailnetRuntime } from "../core/tailnet/runtime";
import { prepareTailnet, waitForTailnetHandoff } from "./dev-tailnet";

const app = { port: 5173, expose: true, devCommand: "bun server.ts" };

const input = {
	requested: undefined,
	publicExpose: false,
	startApps: { web: app },
	reusedApps: {},
};

const remoteRun: RunEntry = {
	root: "/fixture",
	pid: 123,
	worktree: null,
	projectName: "fixture",
	projectPrefix: "fixture",
	startedAt: "now",
	updatedAt: "now",
	hosts: null,
	cli: { program: "bun" },
	services: [],
	apps: [
		{
			name: "web",
			port: 5173,
			status: "ready",
			url: "https://dev.tail123.ts.net:20000",
			tailnetUrl: "https://dev.tail123.ts.net:20000",
			loopbackUrl: "http://localhost:5173",
		},
	],
};

function fixture(error?: Error) {
	const urls: Record<string, string | undefined> = {};
	const warnings: string[] = [];
	let acquired = 0;

	const env = {
		root: "/fixture",
		ports: { web: 5173 },
		setTailnetUrls(next: Readonly<Record<string, string | undefined>>) {
			Object.assign(urls, next);
		},
	};

	const deps = {
		ci: () => false,
		state: () => ({ version: 1 as const, enabled: true, allocations: [] }),
		healthy: async () => true,
		runs: async (): Promise<RunEntry[]> => [],
		warn: (s: string) => {
			warnings.push(s);
		},
		runtime: () => ({
			...createTailnetRuntime(),
			acquire: async () => {
				acquired++;

				if (error) throw error;

				return { web: "https://dev.tail123.ts.net:20000" };
			},
		}),
	};

	return { env, deps, urls, warnings, acquired: () => acquired };
}

it("falls back locally when Tailscale is disconnected but the coordinator is alive", async () => {
	const f = fixture(new TailnetUnavailableError("Connect Tailscale"));

	await prepareTailnet(f.env, input, f.deps);
	expect(f.urls).toEqual({});
	expect(f.warnings).toHaveLength(1);
	await expect(
		prepareTailnet(f.env, { ...input, requested: true }, f.deps),
	).rejects.toThrow("Connect Tailscale");
});

it("explicit local, public and CI modes do not read corrupt tailnet state", async () => {
	for (const variation of [{ requested: false }, { publicExpose: true }, {}]) {
		const f = fixture();

		await prepareTailnet(
			f.env,
			{ ...input, ...variation },
			{
				...f.deps,
				ci: () => !Object.keys(variation).length,
				state: () => {
					throw new Error("corrupt");
				},
			},
		);
		expect(f.acquired()).toBe(0);
	}
});

it("does not probe remote infrastructure with no eligible apps", async () => {
	const f = fixture();

	await prepareTailnet(
		f.env,
		{ ...input, startApps: { web: { ...app, expose: false } } },
		{
			...f.deps,
			state: () => {
				throw new Error("must not read");
			},
		},
	);
	expect(f.acquired()).toBe(0);
	await expect(
		prepareTailnet(f.env, { ...input, requested: true, startApps: {} }, f.deps),
	).rejects.toThrow("No selected HTTP");
});

it("falls back with a missing coordinator but not when reusing a remote app", async () => {
	const f = fixture();

	await prepareTailnet(f.env, input, { ...f.deps, healthy: async () => false });
	expect(f.warnings).toHaveLength(1);
	expect(f.acquired()).toBe(0);
	await expect(
		prepareTailnet(
			f.env,
			{ ...input, startApps: {}, reusedApps: { web: app } },
			{ ...f.deps, healthy: async () => false, runs: async () => [remoteRun] },
		),
	).rejects.toThrow("unavailable");
});

it("allows default fallback when the reused app is local", async () => {
	const f = fixture(new TailnetUnavailableError("Disconnected"));

	await prepareTailnet(
		f.env,
		{ ...input, startApps: {}, reusedApps: { web: app } },
		f.deps,
	);
	expect(f.warnings).toHaveLength(1);
});

it("rejects a local mode change for an existing remote app", async () => {
	const f = fixture();

	await expect(
		prepareTailnet(
			f.env,
			{ ...input, requested: false, startApps: {}, reusedApps: { web: app } },
			{ ...f.deps, runs: async () => [remoteRun] },
		),
	).rejects.toThrow("--takeover");
});

it("never falls back on incomplete rollback, ownership conflict, or cancellation", async () => {
	for (const error of [
		new Error("pending cleanup"),
		new Error("foreign mapping"),
	]) {
		const f = fixture(error);

		await expect(prepareTailnet(f.env, input, f.deps)).rejects.toThrow(
			error.message,
		);
		expect(f.warnings).toHaveLength(0);
	}

	const f = fixture(new TailnetUnavailableError("unavailable"));
	const controller = new AbortController();

	controller.abort(new Error("cancelled"));
	await expect(
		prepareTailnet(f.env, { ...input, signal: controller.signal }, f.deps),
	).rejects.toThrow("cancelled");
	expect(f.acquired()).toBe(0);
});

it("publishes only successfully acquired private URLs", async () => {
	const f = fixture();

	await prepareTailnet(f.env, input, f.deps);
	expect(f.urls.web).toBe("https://dev.tail123.ts.net:20000");
	expect(f.warnings).toHaveLength(0);
});

it("waits for asynchronous lease release and honors cancellation", async () => {
	let time = 0;

	const deps = {
		now: () => time,
		alive: () => true,
		sleep: async () => {
			time += 100;
		},
		state: () => ({
			version: 1 as const,
			enabled: true,
			allocations:
				time < 300
					? [
							{
								key: "web",
								port: 20000,
								lease: {
									root: "/fixture",
									app: "web",
									pid: 123,
									identity: "birth",
									hostname: "dev.tail123.ts.net",
									upstream: 5173,
									createdAt: 0,
								},
							},
						]
					: [],
		}),
	};

	await waitForTailnetHandoff("/fixture", ["web"], undefined, deps);
	expect(time).toBe(300);

	const controller = new AbortController();

	controller.abort();
	await expect(
		waitForTailnetHandoff("/fixture", ["web"], controller.signal, deps),
	).rejects.toThrow();
});
