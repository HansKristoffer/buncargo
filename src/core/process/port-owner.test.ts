import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { describePortConflict } from "../port-allocation";
import { externalStackProjectName } from "../ports";
import { isProcessAlive } from "./lifecycle";
import {
	canBindPort,
	classifyPortOccupant,
	formatPortOwner,
	killPortOwnerFoundBy,
	type PortOwner,
	signalProcessTree,
	staleStackProject,
	withBindProbe,
} from "./port-owner";

describe("classifyPortOccupant", () => {
	it("reuses a container from this compose project", () => {
		expect(
			classifyPortOccupant(
				{
					pids: [],
					container: {
						id: "abc",
						name: "gey-postgres-1",
						composeProject: "gey-main",
					},
				},
				{ root: "/repo", projectName: "gey-main" },
			),
		).toBe("reuse");
	});

	it("reuses an integration stack's container under its shortened project name", () => {
		// The Supabase CLI cuts project ids at 40 characters; a worktree's
		// project name is often longer, and reading its stack as foreign
		// shifts every port on each warm start.
		const projectName = "myproject-t3code-e92a078e-t3code-e92a078e";
		const stackName = externalStackProjectName(projectName);
		expect(stackName.length).toBeLessThanOrEqual(40);
		expect(stackName).not.toBe(externalStackProjectName(`${projectName}-ci`));
		expect(
			classifyPortOccupant(
				{
					pids: [],
					container: {
						id: "abc",
						name: `supabase_db_${stackName}`,
						composeProject: stackName,
					},
				},
				{ root: "/repo", projectName },
			),
		).toBe("reuse");
	});

	it("fails on a foreign container", () => {
		expect(
			classifyPortOccupant(
				{
					pids: [],
					container: {
						id: "abc",
						name: "other-postgres-1",
						composeProject: "gey-other",
					},
				},
				{ root: "/repo", projectName: "gey-main" },
			),
		).toBe("fail");
	});

	it("refuses to reuse this project's container on the other runtime", () => {
		expect(
			classifyPortOccupant(
				{
					pids: [],
					container: {
						id: "abc",
						name: "gey-postgres-1",
						composeProject: "gey-main",
						runtime: "docker",
					},
				},
				{ root: "/repo", projectName: "gey-main", runtime: "apple" },
			),
		).toBe("fail");
	});

	it("still reuses this project's container on the selected runtime", () => {
		expect(
			classifyPortOccupant(
				{
					pids: [],
					container: {
						id: "abc",
						name: "gey-postgres-1",
						composeProject: "gey-main",
						runtime: "apple",
					},
				},
				{ root: "/repo", projectName: "gey-main", runtime: "apple" },
			),
		).toBe("reuse");
	});

	it("kills an orphan whose cwd is under this repo", () => {
		expect(
			classifyPortOccupant(
				{ pids: [12], command: "vite", cwd: "/repo/apps/web" },
				{ root: "/repo", projectName: "gey-main" },
			),
		).toBe("kill");
	});

	it("fails on a process from another repo", () => {
		expect(
			classifyPortOccupant(
				{ pids: [12], command: "vite", cwd: "/elsewhere" },
				{ root: "/repo", projectName: "gey-main" },
			),
		).toBe("fail");
	});
});

describe("formatPortOwner", () => {
	it("names a container and compose project", () => {
		expect(
			formatPortOwner(5173, {
				pids: [],
				container: {
					id: "abc",
					name: "gey-other-platform-1",
					composeProject: "gey-other",
				},
			}),
		).toBe(
			"port 5173 held by container gey-other-platform-1 (project gey-other)",
		);
	});

	it("does not name the runtime when it is the one in use", () => {
		expect(
			formatPortOwner(
				5173,
				{
					pids: [],
					container: {
						id: "abc",
						name: "gey-other-platform-1",
						composeProject: "gey-other",
						runtime: "docker",
					},
				},
				{ runtime: "docker" },
			),
		).toBe(
			"port 5173 held by container gey-other-platform-1 (project gey-other)",
		);
	});

	it("names the other runtime and how to stop it", () => {
		const message = formatPortOwner(
			13233,
			{
				pids: [84706],
				command: "com.docker.backend",
				container: {
					id: "abc",
					name: "playground-postgres-1",
					composeProject: "playground",
					runtime: "docker",
				},
			},
			{ runtime: "apple" },
		);
		expect(message).toContain("held by container playground-postgres-1");
		expect(message).toContain("running on Docker");
		expect(message).toContain("configured for Apple container");
		expect(message).toContain("buncargo dev --down --runtime=docker");
		// The daemon process is what made the old message useless.
		expect(message).not.toContain("84706");
	});

	it("reads correctly when the holder is Apple, whose name is not an adjective", () => {
		const message = formatPortOwner(
			13333,
			{
				pids: [17513],
				container: {
					id: "abc",
					name: "playground-postgres",
					composeProject: "playground",
					runtime: "apple",
				},
			},
			{ runtime: "docker" },
		);
		expect(message).toContain("running on Apple container while");
		expect(message).not.toContain("Apple container container");
		expect(message).toContain("buncargo dev --down --runtime=apple");
	});
});

describe("stale stacks of this checkout", () => {
	const root = "/work/t3-e144b332";
	const checkout = { root, projectPrefix: "budget-app" };
	const stale = {
		id: "a1",
		name: "bliss-t3-e144b332-redis-1",
		composeProject: "bliss-t3-e144b332",
		root,
	};

	it("is a stack of this root under a name the config no longer gives it", () => {
		expect(staleStackProject(stale, checkout)).toBe("bliss-t3-e144b332");
	});

	it("is never a current name, a suffixed one, another root's or an unlabelled stack", () => {
		const current = { ...stale, composeProject: "budget-app-t3-e144b332" };
		const suffixed = { ...stale, composeProject: "budget-app-t3-e144b332-e2e" };
		const elsewhere = { ...stale, root: "/work/t3-other" };
		const unlabelled = { ...stale, root: undefined };
		for (const container of [current, suffixed, elsewhere, unlabelled])
			expect(staleStackProject(container, checkout)).toBeUndefined();
	});

	it("names the Docker command that removes it, before any runtime mismatch", () => {
		const message = formatPortOwner(
			13379,
			{ pids: [], container: { ...stale, runtime: "docker" } },
			{ runtime: "apple", checkout },
		);
		expect(message).toBe(
			"port 13379 held by container bliss-t3-e144b332-redis-1 (project bliss-t3-e144b332), a stale stack of this checkout, left under the project name its config used before. Remove it with `docker compose -p bliss-t3-e144b332 down` (its volumes are kept), or start with `buncargo dev --replace-stale`, which does that first.",
		);
	});

	it("has no command to name on Apple container, only --replace-stale", () => {
		const message = formatPortOwner(
			13379,
			{ pids: [], container: { ...stale, runtime: "apple" } },
			{ runtime: "apple", checkout },
		);
		expect(message).toContain("`buncargo dev --replace-stale`");
		expect(message).toContain(
			"Apple container removes containers by id, not a project by name",
		);
		expect(message).not.toContain("docker compose");
	});

	it("reaches the allocator's conflict message", () => {
		expect(
			describePortConflict(
				13379,
				{ pids: [], container: stale },
				"docker",
				checkout,
			),
		).toContain("`docker compose -p bliss-t3-e144b332 down`");
		expect(
			describePortConflict(
				13379,
				{ pids: [], container: { ...stale, root: "/work/t3-other" } },
				"docker",
				checkout,
			),
		).toBe(
			"port 13379 held by container bliss-t3-e144b332-redis-1 (project bliss-t3-e144b332)",
		);
	});
});

describe("signalProcessTree", () => {
	it("kills a detached child process", async () => {
		const child = spawn("bun", ["-e", "setInterval(() => {}, 1000)"], {
			detached: true,
			stdio: "ignore",
		});
		expect(child.pid).toBeDefined();
		if (!child.pid) throw new Error("expected pid");
		signalProcessTree(child.pid, "SIGTERM");
		const started = Date.now();
		while (Date.now() - started < 2000 && isProcessAlive(child.pid)) {
			await Bun.sleep(50);
		}
		expect(isProcessAlive(child.pid)).toBe(false);
	});
});

it("does not classify a neighboring checkout sharing a prefix as ours", () => {
	expect(
		classifyPortOccupant(
			{ pids: [123], cwd: "/repo-other/app" },
			{ root: "/repo", projectName: "demo" },
		),
	).toBe("fail");
	expect(
		classifyPortOccupant(
			{ pids: [123], cwd: "/repo/app" },
			{ root: "/repo", projectName: "demo" },
		),
	).toBe("kill");
});

it("does not classify a worktree checked out inside the root as ours", () => {
	const checkouts = new Set(["/repo/.claude/worktrees/x", "/repo/vendor/tool"]);
	const classify = (cwd: string) =>
		classifyPortOccupant(
			{ pids: [123], cwd },
			{
				root: "/repo",
				projectName: "demo",
				isCheckoutRoot: (dir) => checkouts.has(dir),
			},
		);
	expect(classify("/repo/.claude/worktrees/x")).toBe("fail");
	expect(classify("/repo/.claude/worktrees/x/apps/web")).toBe("fail");
	expect(classify("/repo/vendor/tool/bin")).toBe("fail");
	expect(classify("/repo/.claude/worktrees")).toBe("kill");
	expect(classify("/repo/apps/web")).toBe("kill");
	expect(classify("/repo")).toBe("kill");
});

describe("killPortOwner", () => {
	it("never signals the process behind a port a container holds", async () => {
		// On Docker Desktop the listener is the runtime's own backend.
		const backend = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		const pid = backend.pid ?? 0;
		try {
			await expect(
				killPortOwnerFoundBy(
					async () => ({
						pids: [pid],
						command: "com.docker.backend",
						container: { id: "abc", name: "web-1", composeProject: "shop" },
					}),
					5432,
				),
			).rejects.toThrow("Port 5432 is held by container web-1 (project shop)");
			expect(isProcessAlive(pid)).toBe(true);
		} finally {
			process.kill(pid, "SIGKILL");
		}
	});
});

describe("bind probe", () => {
	it("reports a port held on any address", () => {
		// Held on 0.0.0.0 only: 127.0.0.1 still binds, so only probing every
		// address catches it.
		const held = Bun.listen({
			hostname: "0.0.0.0",
			port: 0,
			socket: { data() {} },
		});
		try {
			expect(canBindPort(held.port)).toBe(false);
		} finally {
			held.stop(true);
		}
		expect(canBindPort(held.port)).toBe(true);
	});

	it("turns a hidden holder into a foreign, unidentified owner", () => {
		const lookup = withBindProbe(
			() => null,
			(port) => port !== 8021,
		);
		expect(lookup(8020)).toBeNull();
		const owner = lookup(8021);
		expect(owner?.unidentified).toBe(true);
		expect(
			classifyPortOccupant(owner, { root: "/repo", projectName: "app" }),
		).toBe("fail");
		expect(formatPortOwner(8021, owner as PortOwner)).toContain(
			"unidentified process",
		);
	});

	it("never binds a port the lookup already explained", () => {
		const ours = { pids: [1], cwd: "/repo" };
		const lookup = withBindProbe(
			() => ours,
			() => {
				throw new Error("must not probe");
			},
		);
		expect(lookup(5432)).toBe(ours);
	});
});
