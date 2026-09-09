import { expect, test } from "bun:test";
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
test("temporary sessions preserve unrelated background and foreground routes", async () => {
	const fake = fakeTailscale();
	fake.config.TCP[80] = { TCPForward: "127.0.0.1:3000" };
	const foreign = fake.start(["serve", "--tcp=23333", "127.0.0.1:9000"]);
	const manager = createMappings(fake.command, fake.start);
	try {
		await manager.acquire(mapping);
		await expect(manager.acquire({ ...mapping })).rejects.toThrow(
			"already in use",
		);
		await manager.clear();
		expect(fake.config.TCP).toEqual({ 80: { TCPForward: "127.0.0.1:3000" } });
		expect(Object.keys(fake.config.Foreground)).toHaveLength(1);
		expect(foreign.alive).toBe(true);
		expect(
			fake.calls.some(
				(c) => c.includes("--bg") || c.includes("off") || c.includes("reset"),
			),
		).toBe(false);
	} finally {
		await manager.clear();
		await foreign.close();
	}
});
test("restores lost sessions and refuses another owner of the port", async () => {
	const fake = fakeTailscale();
	const manager = createMappings(fake.command, fake.start);
	try {
		await manager.acquire(mapping);
		fake.config.Foreground = {};
		await manager.restore(mapping, fake.config);
		expect(Object.keys(fake.config.Foreground)).toHaveLength(1);
		fake.config.Foreground = {};
		fake.config.TCP[24444] = { TCPForward: "127.0.0.1:8888" };
		await expect(manager.restore(mapping, fake.config)).rejects.toThrow(
			"already in use",
		);
		await manager.clear();
		expect(fake.config.TCP[24444]).toEqual({ TCPForward: "127.0.0.1:8888" });
	} finally {
		await manager.clear();
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

test("failed Serve startup is closed and never advertised", async () => {
	const fake = fakeTailscale();
	let closed = false;
	const manager = createMappings(fake.command, () => ({
		alive: false,
		async close() {
			closed = true;
		},
	}));
	await expect(manager.acquire(mapping)).rejects.toThrow("did not activate");
	expect(closed).toBe(true);
	expect(fake.config.Foreground).toEqual({});
});
