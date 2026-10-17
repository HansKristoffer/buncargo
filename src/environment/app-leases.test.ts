import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLeases } from "../core/leases";
import type { AppConfig } from "../types";
import { createDevEnvironment } from "./create-dev-environment";

let scratch: string;
let savedHome: string | undefined;
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "buncargo-start-leases-"));
	savedHome = process.env.HOME;
	process.env.HOME = join(scratch, "home");
});
afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(scratch, { recursive: true, force: true });
});

const KEY = "shopify-app:library-test";

/** A worker that writes a marker in its checkout and then stays up. */
function worker(
	marker: string,
	extra: { exclusive?: string; essential?: boolean } = {},
): AppConfig {
	return {
		kind: "worker",
		devCommand: `${process.execPath} -e 'await Bun.write("${marker}", "yes"); setInterval(() => {}, 1000)'`,
		...extra,
	};
}

/** One checkout's library environment, as a script in that worktree builds it. */
function checkout(
	name: string,
	apps: Record<string, AppConfig>,
	hooks: { afterServers?: () => Promise<void> } = {},
) {
	const root = join(scratch, name);
	mkdirSync(root, { recursive: true });
	const env = createDevEnvironment(
		{
			projectPrefix: `leases-${name}`,
			services: {},
			apps,
			hooks,
			options: { verbose: false },
		},
		{ root },
	);
	const start = () =>
		env.start({ productionBuild: false, verbose: false, watchdog: false });
	return { root, env, start };
}

it("refuses an essential exclusive app whose lease another run holds, naming the holder", async () => {
	const first = checkout("first", {
		shopify: worker("shopify", { exclusive: KEY }),
	});
	const second = checkout("second", {
		shopify: worker("shopify", { exclusive: KEY }),
	});
	await first.start();
	try {
		const refusal = await second.start().then(
			() => undefined,
			(error: Error) => error.message,
		);
		expect(refusal).toContain(`${KEY} is in use by another run.`);
		expect(refusal).toContain(`Checkout: ${first.root}`);
		expect(refusal).toContain(`buncargo stop --all --root ${first.root}`);
		expect(existsSync(join(second.root, "shopify"))).toBe(false);
		expect((await readLeases()).map((lease) => lease.root)).toEqual([
			first.root,
		]);
	} finally {
		await first.env.stop({ verbose: false });
	}

	// Stopping the holder frees the lease for the next run.
	expect(await readLeases()).toEqual([]);
	await second.start();
	try {
		expect((await readLeases()).map((lease) => lease.root)).toEqual([
			second.root,
		]);
	} finally {
		await second.env.stop({ verbose: false });
	}
});

it("starts the rest without an optional exclusive app whose lease another run holds", async () => {
	const first = checkout("first", {
		shopify: worker("shopify", { exclusive: KEY }),
	});
	const second = checkout("second", {
		shopify: worker("shopify", { exclusive: KEY, essential: false }),
		jobs: worker("jobs"),
	});
	const warnings: string[] = [];
	const warn = spyOn(console, "warn").mockImplementation((...parts) => {
		warnings.push(parts.join(" "));
	});
	await first.start();
	try {
		const pids = await second.start();
		expect(Object.keys(pids ?? {})).toEqual(["jobs"]);
		const said = warnings.join("\n");
		expect(said).toContain(
			`Not starting shopify: ${KEY} is held by another run.`,
		);
		expect(said).toContain(`buncargo stop --all --root ${first.root}`);
		expect((await readLeases()).map((lease) => lease.root)).toEqual([
			first.root,
		]);
	} finally {
		warn.mockRestore();
		await second.env.stop({ verbose: false });
		await first.env.stop({ verbose: false });
	}
});

it("gives a lease back when the start that took it fails", async () => {
	const run = checkout(
		"failing",
		{ shopify: worker("shopify", { exclusive: KEY }) },
		{
			afterServers: async () => {
				throw new Error("afterServers failed");
			},
		},
	);
	await expect(run.start()).rejects.toThrow("afterServers failed");
	expect(await readLeases()).toEqual([]);
	await run.env.stop({ verbose: false });
});
