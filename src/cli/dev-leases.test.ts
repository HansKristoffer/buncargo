import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkippedLeaseApp } from "../core/app-leases";
import { readLeases } from "../core/leases";
import { publishCurrentRun, type RunSource } from "../core/run-publish";
import { patchRun } from "../core/run-registry";
import { acquireAppLeases, leaseSkipLines } from "./dev-leases";
import { CliError } from "./errors";

let root: string;
let savedHome: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "buncargo-dev-leases-"));
	savedHome = process.env.HOME;
	process.env.HOME = root;
});
afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(root, { recursive: true, force: true });
});

const apps = {
	web: { port: 3000, devCommand: "bun dev", exclusive: "fixture:exclusive" },
};
function source(sessionId: string): RunSource {
	return {
		sessionId,
		root,
		projectPrefix: "fixture",
		projectName: "fixture",
		isWorktree: false,
		ports: { web: 3000 },
		urls: {},
		loopbackUrls: {},
		publicUrls: {},
		hosts: null,
		services: {},
		containerRuntime: "docker",
		resolvePrimaryApp: () => "web",
	};
}

it.each(["starting", "identity-refused"])(
	"retains an exclusive lease when its holder is %s",
	async (state) => {
		const owner = source("owner");
		await acquireAppLeases(owner, apps, { takeover: { kind: "none" } });
		await publishCurrentRun(owner, { apps, serviceNames: [] });
		if (state === "identity-refused") {
			// Deliberately mismatched: this test must never signal the test process.
			await patchRun(owner.sessionId, {
				apps: [
					{
						name: "web",
						status: "ready",
						pid: process.pid,
						processIdentity: "invalid-test-identity",
					},
				],
			});
		}
		await expect(
			acquireAppLeases(source("contender"), apps, {
				takeover: { kind: "all" },
			}),
		).rejects.toThrow("Could not stop fixture:exclusive");
		expect((await readLeases()).map((lease) => lease.sessionId)).toEqual([
			"owner",
		]);
	},
);

// The run already took the app over (a `y`, or an unhealthy detached app):
// its lease follows without a second question, and without a terminal it is
// not refused after the other run's server was stopped.
it("moves the lease of an app this run already took over without asking", async () => {
	const owner = source("owner");
	await acquireAppLeases(owner, apps, { takeover: { kind: "none" } });
	await publishCurrentRun(owner, { apps, serviceNames: [] });
	await expect(
		acquireAppLeases(source("contender"), apps, {
			takeover: { kind: "apps", names: new Set(["web"]) },
			interactive: false,
			confirm: () => {
				throw new Error("must not ask");
			},
		}),
		// Its holder is still starting, so the transfer is what refuses.
	).rejects.toThrow("Could not stop fixture:exclusive");
	// Another app taken over is no answer for this one.
	await expect(
		acquireAppLeases(source("contender"), apps, {
			takeover: { kind: "apps", names: new Set(["api"]) },
			interactive: false,
		}),
	).rejects.toThrow("fixture:exclusive is in use by another run.");
});

describe("a lease held by another run", () => {
	const optionalApps = {
		shopify: {
			kind: "worker" as const,
			devCommand: "shopify app dev",
			essential: false,
			exclusive: "shopify-app:abc",
		},
	};

	it("skips an essential: false app without a terminal, naming the holder", async () => {
		await acquireAppLeases(source("owner"), optionalApps, {
			takeover: { kind: "none" },
		});
		const { skipped } = await acquireAppLeases(
			source("contender"),
			optionalApps,
			{ takeover: { kind: "none" }, interactive: false },
		);

		expect(skipped.map((skip) => [skip.app, skip.key])).toEqual([
			["shopify", "shopify-app:abc"],
		]);
		expect(skipped[0]?.holder.sessionId).toBe("owner");
		// The lease stays where it was.
		expect((await readLeases()).map((lease) => lease.sessionId)).toEqual([
			"owner",
		]);

		const lines = leaseSkipLines(skipped[0] as SkippedLeaseApp).join("\n");
		expect(lines).toContain(
			"Not starting shopify: shopify-app:abc is held by another run.",
		);
		expect(lines).toContain(`Checkout: ${root}`);
		expect(lines).toContain(`pid ${process.pid}`);
		expect(lines).toContain("buncargo dev --takeover");
	});

	it("asks in a terminal, and Enter starts the run without the app", async () => {
		await acquireAppLeases(source("owner"), optionalApps, {
			takeover: { kind: "none" },
		});
		const asked: string[][] = [];
		const { skipped } = await acquireAppLeases(
			source("contender"),
			optionalApps,
			{
				takeover: { kind: "none" },
				interactive: true,
				confirm: async (lines) => {
					asked.push(lines);
					return false;
				},
			},
		);

		expect(skipped.map((skip) => skip.app)).toEqual(["shopify"]);
		const prompt = asked[0]?.join("\n") ?? "";
		expect(prompt).toContain("shopify cannot start here");
		expect(prompt).toContain(root);
		expect(prompt).toContain("Enter to start without shopify");
	});

	it("refuses the run for an essential app, with the takeover flag", async () => {
		await acquireAppLeases(source("owner"), apps, {
			takeover: { kind: "none" },
		});
		const refusal = acquireAppLeases(source("contender"), apps, {
			takeover: { kind: "none" },
			interactive: false,
		});
		await expect(refusal).rejects.toBeInstanceOf(CliError);
		const error = (await refusal.catch(
			(caught: unknown) => caught,
		)) as CliError;
		expect(error.message).toBe("fixture:exclusive is in use by another run.");
		expect(error.hints.join("\n")).toContain(`Checkout: ${root}`);
		expect(error.hints.join("\n")).toContain("buncargo dev --takeover");
	});

	it("does not prompt or skip when the lease is free", async () => {
		const { skipped } = await acquireAppLeases(source("solo"), optionalApps, {
			takeover: { kind: "none" },
			interactive: true,
			confirm: () => {
				throw new Error("must not ask");
			},
		});
		expect(skipped).toEqual([]);
	});
});
