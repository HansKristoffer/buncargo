import { describe, expect, it } from "bun:test";
import {
	createUpstreamResolver,
	describeUpstreamFamilies,
	UPSTREAM_FAMILIES,
} from "./upstream";

describe("UPSTREAM_FAMILIES", () => {
	it("prefers IPv4 and brackets the IPv6 authority", () => {
		expect(UPSTREAM_FAMILIES.map((family) => family.host)).toEqual([
			"127.0.0.1",
			"::1",
		]);
		expect(UPSTREAM_FAMILIES.map((family) => family.authority)).toEqual([
			"127.0.0.1",
			"[::1]",
		]);
	});
});

describe("describeUpstreamFamilies", () => {
	it("names both families for an error message", () => {
		expect(describeUpstreamFamilies()).toBe("127.0.0.1 or [::1]");
	});
});

describe("createUpstreamResolver", () => {
	it("returns IPv4 when it accepts", async () => {
		const resolver = createUpstreamResolver({
			probe: async (_port, host) => host === "127.0.0.1",
		});
		expect((await resolver.resolve(4901))?.authority).toBe("127.0.0.1");
	});

	it("falls back to IPv6 when IPv4 refuses", async () => {
		const resolver = createUpstreamResolver({
			probe: async (_port, host) => host === "::1",
		});
		expect((await resolver.resolve(4901))?.authority).toBe("[::1]");
	});

	it("resolves to undefined when neither family accepts", async () => {
		const resolver = createUpstreamResolver({ probe: async () => false });
		expect(await resolver.resolve(4901)).toBeUndefined();
	});

	it("probes once per port and reuses the answer", async () => {
		const probed: string[] = [];
		const resolver = createUpstreamResolver({
			probe: async (_port, host) => {
				probed.push(host);
				return host === "::1";
			},
		});

		await resolver.resolve(4901);
		await resolver.resolve(4901);

		expect(probed).toEqual(["127.0.0.1", "::1"]);
	});

	it("collapses concurrent first requests into one probe", async () => {
		let probes = 0;
		const resolver = createUpstreamResolver({
			probe: async (_port, host) => {
				probes += 1;
				await Bun.sleep(5);
				return host === "127.0.0.1";
			},
		});

		const [a, b] = await Promise.all([
			resolver.resolve(4901),
			resolver.resolve(4901),
		]);

		expect(probes).toBe(1);
		expect(a?.authority).toBe("127.0.0.1");
		expect(b?.authority).toBe("127.0.0.1");
	});

	it("re-probes after forget, so a restart can switch family", async () => {
		let family = "127.0.0.1";
		const resolver = createUpstreamResolver({
			probe: async (_port, host) => host === family,
		});

		expect((await resolver.resolve(4901))?.authority).toBe("127.0.0.1");

		family = "::1";
		expect((await resolver.resolve(4901))?.authority).toBe("127.0.0.1");

		resolver.forget(4901);
		expect((await resolver.resolve(4901))?.authority).toBe("[::1]");
	});

	it("keeps ports independent", async () => {
		const resolver = createUpstreamResolver({
			probe: async (port, host) =>
				port === 4900 ? host === "127.0.0.1" : host === "::1",
		});

		expect((await resolver.resolve(4900))?.authority).toBe("127.0.0.1");
		expect((await resolver.resolve(4901))?.authority).toBe("[::1]");
	});
});
