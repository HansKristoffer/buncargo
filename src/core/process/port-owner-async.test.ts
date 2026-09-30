import { expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import { dockerRuntimeAdapter } from "../../docker/adapter";
import { shellQuote } from "../shell-quote";
import { createPortOwnerSnapshotAsync } from "./port-owner";
import { emptyListenerSnapshot } from "./port-snapshot";

it("prefers the selected backend and resolves independent backends concurrently", async () => {
	let started = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const adapter = (name: "docker" | "apple", port: number) =>
		({
			name,
			containerPortOwners: () => {
				throw new Error("blocking fallback used");
			},
			containerPortOwnersAsync: async () => {
				if (++started === 2) release();
				await gate;
				return new Map([[port, { id: name, name }]]);
			},
		}) as unknown as ContainerRuntimeAdapter;
	const snapshot = await createPortOwnerSnapshotAsync({
		listeners: emptyListenerSnapshot(),
		runtime: adapter("apple", 3000),
		fallbackRuntimes: [adapter("docker", 3000)],
	});
	expect(snapshot.owner(3000)?.container).toMatchObject({
		id: "apple",
		runtime: "apple",
	});
});

it("keeps synchronous custom adapters compatible and resolves supplied cwd data", async () => {
	const listeners = emptyListenerSnapshot();
	listeners.pidsByPort.set(3000, [42]);
	listeners.commandByPid.set(42, "bun");
	const runtime = {
		name: "docker",
		containerPortOwners: () => new Map(),
	} as unknown as ContainerRuntimeAdapter;
	const snapshot = await createPortOwnerSnapshotAsync({
		listeners,
		runtime,
		ports: [3000],
		cwds: new Map([[42, "/checkout"]]),
	});
	expect(snapshot.owner(3000)).toMatchObject({
		pids: [42],
		command: "bun",
		cwd: "/checkout",
	});
	expect(snapshot.isBusy(3001)).toBe(false);
});

it("cancels an in-flight container listing without blocking the event loop", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo async inventory "));
	const binary = join(root, "docker");
	const script = join(root, "slow.ts");
	writeFileSync(
		script,
		"await Bun.write('started', 'yes'); await Bun.sleep(60000);",
	);
	writeFileSync(
		binary,
		`#!/bin/sh\ncd ${shellQuote(root)}\nexec ${shellQuote(process.execPath)} ${shellQuote(script)}\n`,
	);
	chmodSync(binary, 0o700);
	const controller = new AbortController();
	try {
		const reading = createPortOwnerSnapshotAsync({
			listeners: emptyListenerSnapshot(),
			runtime: dockerRuntimeAdapter({ binary }),
			signal: controller.signal,
		});
		// Attach rejection handling immediately, then wait until the slow child runs.
		const settled = reading.then(
			() => undefined,
			(error) => error,
		);
		const deadline = performance.now() + 3000;
		while (!(await Bun.file(join(root, "started")).exists())) {
			if (performance.now() > deadline)
				throw new Error("inventory never started");
			await Bun.sleep(10);
		}
		controller.abort(new Error("cancel inventory"));
		expect(await settled).toMatchObject({ message: "cancel inventory" });
	} finally {
		controller.abort();
		rmSync(root, { recursive: true, force: true });
	}
});
