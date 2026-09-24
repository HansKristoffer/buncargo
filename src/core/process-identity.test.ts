import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	matchesProcessIdentity,
	processIdentityMatcher,
	readProcessIdentities,
	readProcessIdentity,
} from "./process-identity";

describe("readProcessIdentities", () => {
	it("agrees with the single-pid form, so either may verify the other's record", () => {
		const batched = readProcessIdentities([process.pid]);
		expect(batched.get(process.pid)).toBe(readProcessIdentity(process.pid));
		expect(batched.get(process.pid)).toBeString();
	});

	it("answers for several pids at once, including this process and its parent", () => {
		const pids = [process.pid, process.ppid].filter((pid) => pid > 1);
		const identities = readProcessIdentities(pids);
		for (const pid of pids) expect(identities.get(pid)).toBeString();
	});

	it("omits pids that are not running, rather than inventing an identity", async () => {
		const child = Bun.spawn([process.execPath, "--eval", ""], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const pid = child.pid;
		await child.exited;
		expect(readProcessIdentities([pid]).has(pid)).toBe(false);
		expect(readProcessIdentity(pid)).toBeUndefined();
	});

	it("ignores pids no process can have and an empty request", () => {
		expect(readProcessIdentities([]).size).toBe(0);
		expect(readProcessIdentities([0, 1, -5, 1.5]).size).toBe(0);
	});
});

describe("processIdentityMatcher", () => {
	it("accepts a live pid with its own identity and rejects a mismatched one", () => {
		const identity = readProcessIdentity(process.pid);
		const matches = processIdentityMatcher([
			{ pid: process.pid, processIdentity: identity },
		]);
		expect(matches(process.pid, identity)).toBe(true);
		expect(matches(process.pid, "v2:not-this-process")).toBe(false);
		// No recorded identity means "cannot compare", which must stay alive.
		expect(matches(process.pid, undefined)).toBe(true);
	});

	it("rejects a pid that has exited", async () => {
		const child = Bun.spawn([process.execPath, "--eval", ""], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const pid = child.pid;
		await child.exited;
		expect(processIdentityMatcher([{ pid }])(pid, undefined)).toBe(false);
	});
});

describe("liveness over a list that contains a bad pid", () => {
	// The registry keeps the pids of finished runs, and one pid `ps` rejects
	// made it refuse the whole batch. Every live run then read as dead, which
	// is what the sweep acts on.
	const NOT_A_PID = 2 ** 22;

	it("still reads the live process's identity", () => {
		const identity = readProcessIdentity(process.pid);
		const matches = processIdentityMatcher([
			{ pid: NOT_A_PID, processIdentity: "gone" },
			{ pid: process.pid, processIdentity: identity },
		]);
		expect(matches(process.pid, identity)).toBe(true);
		expect(matches(NOT_A_PID, "gone")).toBe(false);
	});

	it("reads the live pid from a batch that also asks about a finished one", async () => {
		const child = Bun.spawn([process.execPath, "--eval", ""], {
			stdout: "ignore",
			stderr: "ignore",
		});
		const finished = child.pid;
		await child.exited;
		// `ps` may exit non-zero over the missing pid; it still printed the
		// live one, and that is what has to come back.
		const identities = readProcessIdentities([process.pid, finished]);
		expect(identities.get(process.pid)).toBe(readProcessIdentity(process.pid));
		expect(identities.has(finished)).toBe(false);
	});
});

describe("identity across environments", () => {
	// Recorded by one process and checked by another: a run and the watchdog,
	// a run and the menu bar's `stop`. `ps` formats the start time in the
	// caller's locale and time zone, so the two used to disagree about a live
	// process and the watchdog read it as dead.
	it("is the same whatever locale and time zone the reader runs in", () => {
		const script = `import { readProcessIdentity } from ${JSON.stringify(
			`${import.meta.dir}/process-identity.ts`,
		)}; process.stdout.write(readProcessIdentity(${process.pid}) ?? "");`;
		const foreign = spawnSync(process.execPath, ["--eval", script], {
			encoding: "utf8",
			env: {
				...process.env,
				LANG: "da_DK.UTF-8",
				LC_ALL: "da_DK.UTF-8",
				TZ: "Asia/Tokyo",
			},
		});
		expect(foreign.stdout).toBe(readProcessIdentity(process.pid) ?? "");
		expect(foreign.stdout).toStartWith("v2:");
	});

	it("still compares an older version's identity exactly as it used to", () => {
		// Strict matching is what `stop` and worker ownership act on, so an
		// identity recorded before the format changed keeps its old meaning:
		// equal when read in the same environment, and nothing more.
		const legacy = spawnSync(
			"ps",
			["-p", String(process.pid), "-o", "lstart="],
			{ encoding: "utf8" },
		).stdout.trim();
		const legacyIdentity =
			process.platform === "linux"
				? undefined
				: new Bun.CryptoHasher("sha256").update(legacy).digest("hex");
		if (legacyIdentity === undefined) return;
		expect(matchesProcessIdentity(process.pid, legacyIdentity)).toBe(true);
		expect(matchesProcessIdentity(process.pid, "0".repeat(64))).toBe(false);
		// Liveness forgives what it cannot compare rather than condemning it.
		expect(
			processIdentityMatcher([{ pid: process.pid }])(
				process.pid,
				"0".repeat(64),
			),
		).toBe(true);
	});
});
