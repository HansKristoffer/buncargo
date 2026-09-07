import { expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailscaleClient } from "./client";

it("cancels a Tailscale CLI that ignores TERM and waits for its exit", async () => {
	const root = await mkdtemp(join(tmpdir(), "buncargo-tailnet-cli-"));
	const path = join(root, "tailscale");
	const pidFile = join(root, "pid");
	const controller = new AbortController();

	try {
		await writeFile(
			path,
			`#!${process.execPath}\nprocess.on('SIGTERM',()=>{}); await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`,
		);
		await chmod(path, 0o700);

		const operation = createTailscaleClient(path)(
			["status", "--json"],
			controller.signal,
		);

		const outcome = operation.then(
			() => undefined,
			(error: unknown) => error,
		);

		// Wait until the child exists so the assertion exercises termination, not pre-spawn cancellation.
		const deadline = Date.now() + 4000;

		while (!(await Bun.file(pidFile).exists()) && Date.now() < deadline)
			await Bun.sleep(20);

		const pid = Number(await Bun.file(pidFile).text());

		controller.abort(new Error("cancelled"));
		expect(await outcome).toMatchObject({ message: "cancelled" });
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		controller.abort();
		await rm(root, { recursive: true, force: true });
	}
}, 10000);

it("bounds CLI output and terminates the overflowing process", async () => {
	const root = await mkdtemp(join(tmpdir(), "buncargo-tailnet-cli-"));
	const path = join(root, "tailscale");
	const pidFile = join(root, "pid");

	try {
		await writeFile(
			path,
			`#!${process.execPath}\nawait Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); console.log('a'.repeat(3*1024*1024)); setInterval(()=>{},1000);`,
		);
		await chmod(path, 0o700);
		await expect(createTailscaleClient(path)(["status"])).rejects.toThrow(
			"output exceeded",
		);

		const pid = Number(await Bun.file(pidFile).text());

		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("forces CLI mode for the macOS bundle in nonterminal environments", async () => {
	const output = await createTailscaleClient(process.execPath)([
		"-e",
		"console.log(process.env.TAILSCALE_BE_CLI)",
	]);

	expect(output.trim()).toBe("1");
});
