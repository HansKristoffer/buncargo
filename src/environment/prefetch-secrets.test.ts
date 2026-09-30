import { expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeInfisical } from "../core/secrets/fake-infisical.testing";
import {
	clearScopeSecretsCache,
	loadAppSecrets,
} from "../core/secrets/infisical";
import { prefetchSecrets } from "./prefetch-secrets";

it("prefetches distinct app, seed and migration scopes and consumers wait near zero", async () => {
	const fake = startFakeInfisical({ requestDelayMs: 100 });
	const home = process.env.HOME;
	const binary = process.env.BUNCARGO_INFISICAL_PATH;
	process.env.HOME = fake.home;
	process.env.BUNCARGO_INFISICAL_PATH = fake.cliPath;
	clearScopeSecretsCache();
	for (const project of ["app", "seed", "migration"])
		fake.projects[project] = { secrets: { KEY: project } };
	const apps = {
		web: {
			port: 3000,
			devCommand: "true",
			secrets: { projectId: "app", siteUrl: fake.siteUrl },
		},
		duplicate: {
			port: 3001,
			devCommand: "true",
			secrets: { projectId: "app", siteUrl: fake.siteUrl },
		},
	};
	try {
		const pending = prefetchSecrets({
			apps,
			defaults: { siteUrl: fake.siteUrl },
			seed: { projectId: "seed" },
			includeSeed: true,
			migrations: [
				{
					name: "migration",
					command: "true",
					secrets: { projectId: "migration" },
				},
			],
		});
		expect(pending).toHaveLength(3);
		await Promise.all(pending);
		expect(
			fake.requests.filter((request) => request === "GET /api/v4/secrets"),
		).toHaveLength(3);
		expect(fake.cliCalls()).toHaveLength(1);
		const waits: number[] = [];
		expect(
			await loadAppSecrets(apps, undefined, { onWait: (ms) => waits.push(ms) }),
		).toEqual({ web: { KEY: "app" }, duplicate: { KEY: "app" } });
		expect(waits[0]).toBeLessThan(20);
	} finally {
		clearScopeSecretsCache();
		fake.stop();
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		if (binary === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = binary;
	}
});

it("aborts the CLI fetch and releases its machine lock", async () => {
	const fake = startFakeInfisical();
	const home = process.env.HOME;
	const binary = process.env.BUNCARGO_INFISICAL_PATH;
	process.env.HOME = fake.home;
	process.env.BUNCARGO_INFISICAL_PATH = fake.cliPath;
	clearScopeSecretsCache();
	const marker = join(fake.home, "started");
	const hung = join(fake.home, "hung.ts");
	writeFileSync(
		hung,
		`await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
	);
	writeFileSync(
		fake.cliPath,
		`#!/bin/sh\nexec '${process.execPath}' '${hung}'\n`,
	);
	const controller = new AbortController();
	try {
		const pending = prefetchSecrets({
			apps: {},
			defaults: { projectId: "p1", siteUrl: fake.siteUrl },
			includeSeed: true,
			migrations: [],
			signal: controller.signal,
		});
		const deadline = Date.now() + 5000;
		while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
		expect(existsSync(marker)).toBe(true);
		controller.abort(new Error("cancelled"));
		const results = await Promise.allSettled(pending);
		expect(results[0]?.status).toBe("rejected");
		expect(existsSync(join(fake.home, ".buncargo", "infisical-cli.lock"))).toBe(
			false,
		);
		const pid = Number(await Bun.file(marker).text());
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		controller.abort();
		clearScopeSecretsCache();
		fake.stop();
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		if (binary === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = binary;
	}
});

it("reports a failed prefetched scope only once when consumers retry", async () => {
	const fake = startFakeInfisical({ cliFails: true });
	const home = process.env.HOME;
	const binary = process.env.BUNCARGO_INFISICAL_PATH;
	const warn = console.warn;
	const warnings: string[] = [];
	process.env.HOME = fake.home;
	process.env.BUNCARGO_INFISICAL_PATH = fake.cliPath;
	console.warn = (message) => warnings.push(String(message));
	clearScopeSecretsCache();
	const apps = {
		web: {
			port: 3000,
			devCommand: "true",
			secrets: { projectId: "p1", siteUrl: fake.siteUrl },
		},
	};
	try {
		await Promise.allSettled(
			prefetchSecrets({ apps, includeSeed: false, migrations: [] }),
		);
		expect(warnings).toEqual([]);
		expect(await loadAppSecrets(apps, undefined)).toEqual({ web: {} });
		expect(await loadAppSecrets(apps, undefined)).toEqual({ web: {} });
		expect(warnings).toHaveLength(1);
	} finally {
		console.warn = warn;
		clearScopeSecretsCache();
		fake.stop();
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		if (binary === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = binary;
	}
});
