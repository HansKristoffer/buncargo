import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "../process/lifecycle";
import { CHILD_GUARD } from "./child-guard";

test("a lost parent pipe terminates the userspace daemon even when it ignores SIGTERM", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-guard-")),
		pidfile = join(dir, "pid"),
		script = join(dir, "daemon.js");
	await writeFile(
		script,
		`require("node:fs").writeFileSync(${JSON.stringify(pidfile)},String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000);`,
	);
	const guard = spawn(
		process.execPath,
		["-e", CHILD_GUARD, "--", dir, process.execPath, script],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	const exited = new Promise<void>((resolve) =>
		guard.once("exit", () => resolve()),
	);
	let pid: number | undefined;
	try {
		for (let i = 0; i < 100 && !existsSync(pidfile); i++) await Bun.sleep(20);
		pid = Number(await readFile(pidfile, "utf8"));
		expect(isProcessAlive(pid)).toBe(true);
		guard.stdin.end();
		await exited;
		expect(isProcessAlive(pid)).toBe(false);
		expect(existsSync(dir)).toBe(false);
	} finally {
		guard.kill("SIGKILL");
		if (pid && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
		await rm(dir, { recursive: true, force: true });
	}
}, 10000);
