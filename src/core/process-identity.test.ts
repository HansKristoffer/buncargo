import { describe, expect, it } from "bun:test";
import {
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
		expect(matches(process.pid, "not-this-process")).toBe(false);
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
