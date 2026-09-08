import { expect, test } from "bun:test";

test("Tailcat guardian terminates the owned child when its parent dies", async () => {
	const source = `
 import { startTailcat } from ${JSON.stringify(new URL("./process.ts", import.meta.url).pathname)};
 const child = await startTailcat(["-e", 'console.log(JSON.stringify({pid:process.pid})); setInterval(()=>{},1000)'], line => JSON.parse(line).pid);
 console.log(child.value);
 setInterval(()=>{},1000);
 `;
	const parent = Bun.spawn([process.execPath, "-e", source], {
		env: { ...process.env, BUNCARGO_TAILCAT_PATH: process.execPath },
		stdout: "pipe",
		stderr: "ignore",
	});
	let pid: number | undefined;
	try {
		const reader = parent.stdout.getReader();
		const first = await reader.read();
		pid = Number(new TextDecoder().decode(first.value).trim());
		expect(pid).toBeGreaterThan(1);
		parent.kill("SIGKILL");
		await parent.exited;
		await reader.cancel();
		let alive = true;
		for (let i = 0; i < 100; i++) {
			try {
				process.kill(pid as number, 0);
			} catch {
				alive = false;
				break;
			}
			await Bun.sleep(50);
		}
		expect(alive).toBe(false);
	} finally {
		parent.kill();
		if (pid)
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
	}
}, 10000);
