import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
	matchesProcessIdentity,
	matchesProcessIdentityAsync,
	processIdentityMatcher,
	processIdentityMatcherAsync,
	readProcessIdentities,
	readProcessIdentitiesAsync,
	readProcessIdentity,
} from "./process-identity";
import { shellQuote } from "./shell-quote";

describe("asynchronous identity inspection", () => {
	it.skipIf(process.platform === "linux")(
		"preserves partial ps output and keeps unknown liveness separate from strict matching",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "buncargo partial ps "));
			const script = join(root, "ps.ts");
			writeFileSync(
				script,
				`if (!process.env.EMPTY_PS) console.log(process.argv.at(-1).split(",")[0] + " Wed Sep 30 12:00:00 2026"); process.exit(1);`,
			);
			writeFileSync(
				join(root, "ps"),
				`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
			);
			chmodSync(join(root, "ps"), 0o700);
			const harness = `
			import { readProcessIdentitiesAsync, processIdentityMatcherAsync, matchesProcessIdentityAsync } from ${JSON.stringify(import.meta.path.replace(".test.ts", ".ts"))};
			const identities = await readProcessIdentitiesAsync([process.pid,99999999]);
			process.env.EMPTY_PS = "1";
			const matches = await processIdentityMatcherAsync([{pid:process.pid,processIdentity:"v2:unreadable"}]);
			console.log(JSON.stringify({hasSelf:identities.has(process.pid),hasMissing:identities.has(99999999),alive:matches(process.pid,"v2:unreadable"),strict:await matchesProcessIdentityAsync(process.pid,"v2:unreadable")}));
		`;
			try {
				const child = Bun.spawn([process.execPath, "--eval", harness], {
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						EMPTY_PS: "",
						PATH: root + delimiter + process.env.PATH,
					},
				});
				const [stdout, stderr, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(JSON.parse(stdout)).toEqual({
					hasSelf: true,
					hasMissing: false,
					alive: true,
					strict: false,
				});
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
	it("shares identity format and strict/liveness policy with synchronous readers", async () => {
		const child = Bun.spawn([process.execPath, "--eval", ""], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await child.exited;
		const identities = await readProcessIdentitiesAsync([
			process.pid,
			process.pid,
			child.pid,
			0,
			1,
			-1,
		]);
		const identity = identities.get(process.pid);
		expect(identity).toBe(readProcessIdentity(process.pid));
		expect(identities.size).toBe(1);
		expect(await matchesProcessIdentityAsync(process.pid, identity)).toBe(true);
		expect(await matchesProcessIdentityAsync(process.pid, "v2:wrong")).toBe(
			false,
		);
		const matches = await processIdentityMatcherAsync([
			{ pid: process.pid },
			{ pid: child.pid },
		]);
		expect(matches(process.pid, identity)).toBe(true);
		expect(matches(process.pid, "legacy-unknown")).toBe(true);
		expect(matches(child.pid)).toBe(false);
	});

	it("honors cancellation even for an empty request", async () => {
		const signal = AbortSignal.abort(new Error("cancel identities"));
		await expect(readProcessIdentitiesAsync([], signal)).rejects.toThrow(
			"cancel identities",
		);
		await expect(
			matchesProcessIdentityAsync(process.pid, undefined, signal),
		).rejects.toThrow("cancel identities");
	});

	it.skipIf(process.platform === "linux")(
		"cancels a slow ps without blocking timers and waits for the child to exit",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "buncargo async ps "));
			const script = join(root, "slow.ts");
			writeFileSync(
				script,
				`await Bun.write(${JSON.stringify(join(root, "pid"))}, String(process.pid)); await Bun.sleep(60000);`,
			);
			writeFileSync(
				join(root, "ps"),
				`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)}\n`,
			);
			chmodSync(join(root, "ps"), 0o700);
			const harness = `
			import { readProcessIdentitiesAsync } from ${JSON.stringify(import.meta.path.replace(".test.ts", ".ts"))};
			const controller = new AbortController();
			const result = readProcessIdentitiesAsync([process.pid], controller.signal).catch(error => error);
			const deadline = performance.now() + 3000;
			while (!(await Bun.file(${JSON.stringify(join(root, "pid"))}).exists())) {
				if (performance.now() > deadline) throw new Error("ps did not start");
				await Bun.sleep(5);
			}
			const pid = Number(await Bun.file(${JSON.stringify(join(root, "pid"))}).text());
			controller.abort(new Error("cancel slow ps"));
			const error = await result;
			let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
			console.log(JSON.stringify({message:error.message,alive}));
		`;
			try {
				const child = Bun.spawn([process.execPath, "--eval", harness], {
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, PATH: root + delimiter + process.env.PATH },
				});
				const [stdout, stderr, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
				expect(JSON.parse(stdout)).toEqual({
					message: "cancel slow ps",
					alive: false,
				});
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

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

	it("still compares an older version's identity exactly as it used to", async () => {
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
		expect(await matchesProcessIdentityAsync(process.pid, legacyIdentity)).toBe(
			true,
		);
		expect(await matchesProcessIdentityAsync(process.pid, "0".repeat(64))).toBe(
			false,
		);
		// Liveness forgives what it cannot compare rather than condemning it.
		expect(
			processIdentityMatcher([{ pid: process.pid }])(
				process.pid,
				"0".repeat(64),
			),
		).toBe(true);
	});
});
