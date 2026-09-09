import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMappings } from "./mappings";
import { parseDirectory } from "./protocol";
import { createPublisher, runTargets } from "./publisher";
import { fakeTailscale, fixtureRun, self } from "./test-helpers.test";

test("target projection omits workers, portless services, credentials and local commands", () => {
	const run = fixtureRun();
	run.apps.push({ name: "worker", kind: "worker", status: "ready" });
	run.services.push({ name: "job", status: "ready" });
	run.services.push({
		name: "custom",
		port: 6000,
		protocol: "http",
		status: "ready",
	});
	expect(runTargets(run).map((t) => [t.name, t.protocol])).toEqual([
		["web", "http"],
		["db", "tcp"],
		["custom", "http"],
	]);
	expect(JSON.stringify(runTargets(run))).not.toContain("secret");
});
test("two worktrees coexist; retiring one preserves the other's mappings and URL", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-publish-")),
		fake = fakeTailscale();
	const mappings = createMappings(fake.command, fake.start);
	const publisher = createPublisher(mappings, dir);
	const a = fixtureRun("a"),
		b = fixtureRun("b", 3001);
	try {
		const initial = await publisher.refresh(self, [a, b]);
		expect(parseDirectory(initial, self).runs).toHaveLength(2);
		expect(
			new Set(initial.runs.flatMap((r) => r.targets.map((t) => t.port))).size,
		).toBe(4);
		expect(JSON.stringify(initial)).not.toContain("secret");
		expect(JSON.stringify(initial)).not.toContain("/workspace/");
		const remaining = await publisher.refresh(self, [b]);
		expect(remaining.runs[0]).toEqual(initial.runs[1]);
		expect(Object.keys(fake.config.Foreground)).toHaveLength(2);
		b.apps[0].status = "stopped";
		const stopped = await publisher.refresh(self, [b]);
		expect(stopped.runs[0].targets.map((t) => t.name)).toEqual(["db"]);
		expect(stopped.runs[0].primaryApp).toBeUndefined();
	} finally {
		await publisher.close();
		await mappings.clear();
		await rm(dir, { recursive: true, force: true });
	}
});

test("restarting a worktree retains its addresses when the upstream port changes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-restart-")),
		fake = fakeTailscale();
	const mappings = createMappings(fake.command, fake.start);
	const publisher = createPublisher(mappings, dir);
	const initial = fixtureRun("first", 3000);
	try {
		const before = await publisher.refresh(self, [initial]);
		await publisher.refresh(self, []);
		const restarted = {
			...initial,
			sessionId: "second",
			apps: [{ ...initial.apps[0], port: 3001 }],
		};
		const after = await publisher.refresh(self, [restarted]);
		expect(after.runs[0].targets.map((t) => t.url)).toEqual(
			before.runs[0].targets.map((t) => t.url),
		);
	} finally {
		await publisher.close();
		await mappings.clear();
		await rm(dir, { recursive: true, force: true });
	}
});

test("new runs cannot claim ports reserved for mappings awaiting restoration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-restore-"));
	const fake = fakeTailscale();
	const mappings = createMappings(fake.command, fake.start);
	const publisher = createPublisher(mappings, dir);
	const existing = fixtureRun("existing");
	const newcomer = { ...fixtureRun("new"), root: existing.root };
	try {
		const initial = await publisher.refresh(self, [existing]);
		fake.config.Foreground = {};
		const restored = await publisher.refresh(self, [newcomer, existing]);
		expect(restored.runs[1]).toEqual(initial.runs[0]);
		expect(
			new Set(
				restored.runs.flatMap((run) =>
					run.targets.map((target) => target.port),
				),
			).size,
		).toBe(4);
	} finally {
		await publisher.close();
		await mappings.clear();
		await rm(dir, { recursive: true, force: true });
	}
});
