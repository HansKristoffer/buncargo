import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMappings,
	type Mapping,
	mappingPort,
	mappingState,
} from "./mappings";
import { fakeTailscale, self } from "./test-helpers.test";

const mapping: Mapping = {
	hostname: self.hostname,
	port: 24444,
	protocol: "http",
	target: "unix:/tmp/private.sock",
};
test("ownership refuses foreign handlers, foreground owners and public Funnel", () => {
	const config = {
		TCP: { 24444: { HTTPS: true } },
		Web: {
			[`${self.hostname}:24444`]: {
				Handlers: { "/": { Proxy: mapping.target } },
			},
		},
	};
	expect(mappingState(config, mapping)).toBe("owned");
	expect(
		mappingState(
			{ ...config, AllowFunnel: { [`${self.hostname}:24444`]: true } },
			mapping,
		),
	).toBe("conflict");
	expect(mappingState({ Foreground: { session: config } }, mapping)).toBe(
		"conflict",
	);
	expect(mappingState({ TCP: { 24444: { HTTPS: true } } }, mapping)).toBe(
		"conflict",
	);
	expect(
		mappingState(
			{
				...config,
				Web: {
					[`${self.hostname}:24444`]: {
						...config.Web[`${self.hostname}:24444`],
						OtherSetting: true,
					},
				},
			},
			mapping,
		),
	).toBe("conflict");
	expect(mappingState({}, mapping)).toBe("free");
});
test("journals before Serve, recovers an interrupted command and preserves unrelated mappings", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-mapping-"));
	const path = join(dir, "mappings.json"),
		fake = fakeTailscale();
	fake.config.TCP[80] = { TCPForward: "127.0.0.1:3000" };
	const manager = await createMappings(async (args) => {
		if (args.includes("--yes")) {
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual([mapping]);
			await fake.command(args);
			throw new Error("process interrupted after mutation");
		}
		return fake.command(args);
	}, path);
	try {
		await expect(manager.acquire(mapping)).rejects.toThrow("interrupted");
		const restarted = await createMappings(fake.command, path);
		await restarted.clear();
		expect(fake.config.TCP).toEqual({ 80: { TCPForward: "127.0.0.1:3000" } });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual([]);
		expect(fake.calls.some((c) => c.includes("reset"))).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("cleanup refuses a target changed outside Buncargo; restoration remains journaled", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-mapping-"));
	const path = join(dir, "mappings.json"),
		fake = fakeTailscale();
	const manager = await createMappings(fake.command, path);
	try {
		await manager.acquire(mapping);
		await manager.clear();
		await manager.restore(mapping, fake.config);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual([mapping]);
		fake.config.TCP[24444] = { TCPForward: "127.0.0.1:8888" };
		await expect(manager.clear()).rejects.toThrow();
		expect(fake.config.TCP[24444]).toEqual({ TCPForward: "127.0.0.1:8888" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("port allocation skips every occupied port and reports exhaustion", () => {
	const port = mappingPort("run:web", new Set());
	expect(mappingPort("run:web", new Set())).toBe(port);
	expect(mappingPort("run:web", new Set([port]))).not.toBe(port);
	expect(() =>
		mappingPort(
			"run:web",
			new Set(Array.from({ length: 10000 }, (_, i) => i + 20000)),
		),
	).toThrow();
});

test("restoration verifies Serve actually activated the mapping", async () => {
	const dir = await mkdtemp(join(tmpdir(), "bc-restore-"));
	const path = join(dir, "mappings.json");
	const fake = fakeTailscale();
	const manager = await createMappings(
		async (args) => (args.includes("--yes") ? "" : fake.command(args)),
		path,
	);
	try {
		await expect(manager.restore(mapping, fake.config)).rejects.toThrow(
			"did not activate",
		);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual([mapping]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
